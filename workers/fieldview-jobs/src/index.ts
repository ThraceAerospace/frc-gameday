import { WorkflowEntrypoint } from "cloudflare:workers";

import { classifyEventThisWeek, lifecycleFor } from "./calendar.ts";
import type { TbaEvent } from "./calendar.ts";

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

    const discovery: Array<{ year: number; count: number; checkedAt: number }> = [];
    for (const year of years) {
      const result = await step.do(`discover-event-directory-${year}`, {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
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
          return { year, count: previous.events.length, checkedAt };
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
        return { year, count: events.length, checkedAt };
      });
      discovery.push(result);
    }

    const classified: Array<{ year: number; eventKeys: string[] }> = [];
    for (const year of years) {
      const result = await step.do(`classify-this-week-${year}`, async () => {
        const document = await readJson<DiscoveryDocument>(this.env.DISCOVERY_BUCKET, `discovery/events/${year}.json`);
        const matches = (document?.events ?? [])
          .filter((item) => classifyEventThisWeek(item, runAt)?.isThisWeek === true)
          .sort((a, b) => a.key.localeCompare(b.key));
        const projection = {
          evaluatedAt: runAt,
          runDate,
          checkedAt: document?.checkedAt ?? runAt,
          events: matches,
        };
        await this.env.DISCOVERY_BUCKET.put(
          `projections/events/this-week/${runAt}/${year}.json`,
          JSON.stringify(projection),
          { httpMetadata: { contentType: "application/json" } },
        );
        return { year, eventKeys: matches.map((item) => item.key) };
      });
      classified.push(result);
    }

    const prepared = await step.do("publish-this-week-generation", async () => {
      const manifestKey = `workflows/daily-event-readiness/${runAt}/events.json`;
      const eventRefs = classified.flatMap(({ year, eventKeys }) => eventKeys.map((key) => ({ year, key })));
      await this.env.DISCOVERY_BUCKET.put(manifestKey, JSON.stringify(eventRefs), {
        httpMetadata: { contentType: "application/json" },
      });
      const pointer = { runAt, runDate, years };
      await this.env.DISCOVERY_BUCKET.put(
        "projections/events/this-week/current.json",
        JSON.stringify(pointer),
        { httpMetadata: { contentType: "application/json" } },
      );
      return { manifestKey, eventCount: eventRefs.length, runDate };
    });

    const keys = await readJson<Array<{ year: number; key: string }>>(this.env.DISCOVERY_BUCKET, prepared.manifestKey);
    if (!keys) throw new Error("Daily readiness manifest disappeared before initialization");
    const initialized: string[] = [];
    const failures: Array<{ event_key: string; error: string }> = [];
    for (let offset = 0; offset < keys.length; offset += 10) {
      const batch = keys.slice(offset, offset + 10);
      const result = await step.do(`initialize-events-${offset / 10}`, {
        retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
      }, async () => {
        const batchInitialized: string[] = [];
        const batchFailures: Array<{ event_key: string; error: string }> = [];
        const documents = new Map<number, DiscoveryDocument | null>();
        for (const item of batch) {
          if (!documents.has(item.year)) {
            documents.set(item.year, await readJson<DiscoveryDocument>(
              this.env.DISCOVERY_BUCKET,
              `discovery/events/${item.year}.json`,
            ));
          }
          const eventData = documents.get(item.year)?.events.find((candidate) => candidate.key === item.key);
          if (!eventData) {
            batchFailures.push({ event_key: item.key, error: "Event was not present in the retained discovery snapshot" });
            continue;
          }
          const classification = lifecycleFor(eventData, runAt);
          const response = await this.env.FIELDVIEW_RUNTIME.fetch(new Request(
            "https://fieldview-runtime/internal/workflows/initialize-event",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.env.RUNTIME_ADMIN_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ event_key: item.key, ...classification }),
            },
          ));
          if (!response.ok) batchFailures.push({ event_key: item.key, error: `Runtime returned HTTP ${response.status}` });
          else batchInitialized.push(item.key);
        }
        return { initialized: batchInitialized, failures: batchFailures };
      });
      initialized.push(...result.initialized);
      failures.push(...result.failures);
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
