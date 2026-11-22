import { WorkflowEntrypoint } from "cloudflare:workers";

interface TbaEvent {
  key: string;
  start_date: string;
  end_date: string;
  timezone: string;
  [key: string]: unknown;
}

interface DiscoveryDocument {
  year: number;
  events: TbaEvent[];
  etag: string | null;
  updatedAt: number;
  checkedAt: number;
}

interface JobsEnvironment {
  TBA_API_KEY: string;
  RUNTIME_ADMIN_TOKEN: string;
  DISCOVERY_BUCKET: R2Bucket;
  FIELDVIEW_RUNTIME: Fetcher;
  DAILY_EVENT_READINESS: Workflow;
}

interface WorkflowParameters {
  scheduledAt: number;
}

interface WeekClassification {
  localDate: string;
  weekStart: string;
  weekEnd: string;
  isThisWeek: boolean;
}

function validDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(value: string, days: number): string {
  const date = new Date(value + "T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function classifyEventThisWeek(event: Pick<TbaEvent, "start_date" | "end_date" | "timezone">, now: number): WeekClassification | null {
  if (!validDateOnly(event.start_date) || !validDateOnly(event.end_date) ||
      event.start_date > event.end_date || typeof event.timezone !== "string" || !event.timezone) return null;
  let localDate: string;
  try {
    const parts = new Map(new Intl.DateTimeFormat("en-US", {
      timeZone: event.timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
    localDate = String(parts.get("year")).padStart(4, "0") + "-" +
      String(parts.get("month")).padStart(2, "0") + "-" + String(parts.get("day")).padStart(2, "0");
  } catch {
    return null;
  }
  const weekday = new Date(localDate + "T00:00:00.000Z").getUTCDay();
  const weekStart = addDays(localDate, -((weekday + 6) % 7));
  const weekEnd = addDays(weekStart, 6);
  return { localDate, weekStart, weekEnd, isThisWeek: event.start_date <= weekEnd && event.end_date >= weekStart };
}

function lifecycleFor(event: TbaEvent, now: number): "upcoming" | "active" | "completed" {
  const classification = classifyEventThisWeek(event, now);
  if (!classification) return "completed";
  if (classification.localDate < event.start_date) return "upcoming";
  if (classification.localDate <= event.end_date) return "active";
  return "completed";
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? object.json<T>() : null;
}

/**
 * Daily discovery and this-week projection now run as a Workflow. EventRuntime
 * remains the owner of canonical event state and active-event polling.
 */
export class DailyEventReadinessWorkflow extends WorkflowEntrypoint<JobsEnvironment, WorkflowParameters> {
  async run(event: WorkflowEvent<WorkflowParameters>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const runAt = event.payload.scheduledAt;
    const runDate = new Date(runAt).toISOString().slice(0, 10);
    const utcYear = Number(runDate.slice(0, 4));
    const years = [utcYear - 1, utcYear, utcYear + 1];

    const discovery = await step.do("discover-event-directories", {
      retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
    }, async () => {
      const results: Array<{ year: number; count: number; checkedAt: number }> = [];
      for (const year of years) {
        const key = `discovery/events/${year}.json`;
        const previous = await readJson<DiscoveryDocument>(this.env.DISCOVERY_BUCKET, key);
        const headers = new Headers({ "X-TBA-Auth-Key": this.env.TBA_API_KEY });
        if (previous?.etag) headers.set("If-None-Match", previous.etag);
        const response = await fetch(`https://www.thebluealliance.com/api/v3/events/${year}`, { headers });
        const checkedAt = Date.now();
        if (response.status === 304 && previous) {
          const refreshed = { ...previous, checkedAt };
          await this.env.DISCOVERY_BUCKET.put(key, JSON.stringify(refreshed), {
            httpMetadata: { contentType: "application/json" },
          });
          results.push({ year, count: previous.events.length, checkedAt });
          continue;
        }
        if (!response.ok) throw new Error(`TBA event discovery for ${year} returned HTTP ${response.status}`);
        const events = await response.json() as TbaEvent[];
        if (!Array.isArray(events) || events.some((item) => !item || typeof item.key !== "string")) {
          throw new Error(`TBA event discovery for ${year} returned an invalid event directory`);
        }
        const document: DiscoveryDocument = {
          year, events, etag: response.headers.get("ETag"), updatedAt: checkedAt, checkedAt,
        };
        await this.env.DISCOVERY_BUCKET.put(key, JSON.stringify(document), {
          httpMetadata: { contentType: "application/json" },
        });
        results.push({ year, count: events.length, checkedAt });
      }
      return results;
    });

    const prepared = await step.do("classify-this-week-events", async () => {
      const allEvents: TbaEvent[] = [];
      for (const year of years) {
        const document = await readJson<DiscoveryDocument>(this.env.DISCOVERY_BUCKET, `discovery/events/${year}.json`);
        if (document) allEvents.push(...document.events);
      }
      const unique = new Map<string, TbaEvent>();
      for (const item of allEvents) if (typeof item.key === "string") unique.set(item.key, item);
      const now = Date.now();
      const matches = [...unique.values()]
        .filter((item) => classifyEventThisWeek(item, now)?.isThisWeek === true)
        .sort((a, b) => a.key.localeCompare(b.key));
      const runDay = new Date(runAt).toISOString().slice(0, 10);
      const projection = {
        evaluatedAt: now,
        runDate: runDay,
        checkedAt: Math.min(...discovery.map((item) => item.checkedAt)),
        events: matches,
      };
      const manifestKey = `workflows/daily-event-readiness/${runAt}/events.json`;
      await this.env.DISCOVERY_BUCKET.put(manifestKey, JSON.stringify(matches.map((item) => item.key)), {
        httpMetadata: { contentType: "application/json" },
      });
      await this.env.DISCOVERY_BUCKET.put("projections/events/this-week.json", JSON.stringify(projection), {
        httpMetadata: { contentType: "application/json" },
      });
      return { manifestKey, eventCount: matches.length, evaluatedAt: now, runDate: runDay };
    });

    const keys = await readJson<string[]>(this.env.DISCOVERY_BUCKET, prepared.manifestKey);
    if (!keys) throw new Error("Daily readiness manifest disappeared before initialization");
    const initialized: string[] = [];
    const failures: Array<{ event_key: string; error: string }> = [];
    for (let offset = 0; offset < keys.length; offset += 10) {
      const batch = keys.slice(offset, offset + 10);
      await step.do(`initialize-events-${offset / 10}`, {
        retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
      }, async () => {
        for (const key of batch) {
          const document = await readJson<DiscoveryDocument>(
            this.env.DISCOVERY_BUCKET,
            `discovery/events/${utcYear}.json`,
          );
          const eventData = document?.events.find((item) => item.key === key);
          if (!eventData) {
            failures.push({ event_key: key, error: "Event was not present in the retained discovery snapshot" });
            continue;
          }
          const classification = lifecycleFor(eventData, Date.now());
          const response = await this.env.FIELDVIEW_RUNTIME.fetch(new Request(
            "https://fieldview-runtime/internal/workflows/initialize-event",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.env.RUNTIME_ADMIN_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ event_key: key, lifecycle: classification }),
            },
          ));
          if (!response.ok) failures.push({ event_key: key, error: `Runtime returned HTTP ${response.status}` });
          else initialized.push(key);
        }
        return { processed: batch.length };
      });
    }

    const summary = {
      run_date: prepared.runDate,
      discovery: discovery.map(({ year, count }) => ({ year, count })),
      this_week_events: prepared.eventCount,
      initialized: initialized.length,
      failed: failures.length,
      failures: failures.slice(0, 100),
    };
    await this.env.DISCOVERY_BUCKET.put(
      `workflows/daily-event-readiness/${runAt}/summary.json`,
      JSON.stringify(summary),
      { httpMetadata: { contentType: "application/json" } },
    );
    return summary;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ service: "fieldview-jobs", status: "ok" });
    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: JobsEnvironment): Promise<void> {
    const id = `daily-event-readiness-${new Date(controller.scheduledTime).toISOString().slice(0, 10)}`;
    try {
      await env.DAILY_EVENT_READINESS.create({ id, params: { scheduledAt: controller.scheduledTime } });
      console.log("[FV][Jobs] Daily event-readiness Workflow created", JSON.stringify({ id }));
    } catch (error) {
      // A duplicate scheduled occurrence must not create overlapping runs.
      console.warn("[FV][Jobs] Daily event-readiness Workflow was not created", JSON.stringify({
        id, error: error instanceof Error ? error.message : String(error),
      }));
    }
  },
};
