import { WorkflowEntrypoint } from "cloudflare:workers";

import { classifyEventThisWeek, lifecycleFor } from "./calendar.ts";
import type { TbaEvent } from "./calendar.ts";

interface DiscoveryDocument {
  year: number;
  events: TbaEvent[];
  chunkCount: number;
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

    const discovery: Array<{ year: number; count: number; checkedAt: number; generation: number; chunkCount: number }> = [];
    const eventChunkSize = 50;
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
          const chunkCount = previous.chunkCount ?? Math.ceil(previous.events.length / eventChunkSize);
          const refreshed = { ...previous, chunkCount, checkedAt };
          await this.env.DISCOVERY_BUCKET.put(key, JSON.stringify(refreshed), {
            httpMetadata: { contentType: "application/json" },
          });
          return { year, count: previous.events.length, checkedAt, generation: previous.updatedAt, chunkCount };
        }
        if (!response.ok) throw new Error(`TBA event discovery for ${year} returned HTTP ${response.status}`);
        const events = await response.json() as TbaEvent[];
        if (!Array.isArray(events) || events.some((item) => !item || typeof item.key !== "string")) {
          throw new Error(`TBA event discovery for ${year} returned an invalid event directory`);
        }
        const chunkCount = Math.ceil(events.length / eventChunkSize);
        for (let index = 0; index < chunkCount; index += 1) {
          await this.env.DISCOVERY_BUCKET.put(
            `discovery/event-chunks/${year}/${checkedAt}/${index}.json`,
            JSON.stringify(events.slice(index * eventChunkSize, (index + 1) * eventChunkSize)),
            { httpMetadata: { contentType: "application/json" } },
          );
        }
        // Publish the directory document last so it never points at an
        // incomplete chunk generation after a retried/partially failed step.
        const document: DiscoveryDocument = {
          year, events, chunkCount, etag: response.headers.get("ETag"), updatedAt: checkedAt, checkedAt,
        };
        await this.env.DISCOVERY_BUCKET.put(key, JSON.stringify(document), {
          httpMetadata: { contentType: "application/json" },
        });
        return { year, count: events.length, checkedAt, generation: checkedAt, chunkCount };
      });
      discovery.push(result);
    }

    const classified: Array<{ year: number; eventRefs: Array<{ key: string; lifecycle: ReturnType<typeof lifecycleFor> }> }> = [];
    for (const directory of discovery) {
      const yearMatches: TbaEvent[] = [];
      for (let chunkIndex = 0; chunkIndex < directory.chunkCount; chunkIndex += 1) {
        const matches = await step.do(`classify-this-week-${directory.year}-${chunkIndex}`, async () => {
          const object = await this.env.DISCOVERY_BUCKET.get(
            `discovery/event-chunks/${directory.year}/${directory.generation}/${chunkIndex}.json`,
          );
          if (!object) throw new Error(`Missing event discovery chunk ${directory.year}/${chunkIndex}`);
          const chunk = await object.json<TbaEvent[]>();
          return chunk.filter((item) => classifyEventThisWeek(item, runAt)?.isThisWeek === true);
        });
        yearMatches.push(...matches);
      }
      await step.do(`publish-this-week-year-${directory.year}`, async () => {
        const projection = {
          evaluatedAt: runAt,
          runDate,
          checkedAt: directory.checkedAt,
          events: yearMatches,
        };
        await this.env.DISCOVERY_BUCKET.put(
          `projections/events/this-week/${runAt}/${directory.year}.json`,
          JSON.stringify(projection),
          { httpMetadata: { contentType: "application/json" } },
        );
        return { year: directory.year, eventCount: yearMatches.length };
      });
      classified.push({
        year: directory.year,
        eventRefs: yearMatches.map((item) => ({ key: item.key, lifecycle: lifecycleFor(item, runAt) })),
      });
    }

    const prepared = await step.do("publish-this-week-generation", async () => {
      const manifestKey = `workflows/daily-event-readiness/${runAt}/events.json`;
      const eventRefs = classified.flatMap(({ year, eventRefs: items }) =>
        items.map(({ key, lifecycle }) => ({ year, key, ...lifecycle })));
      await this.env.DISCOVERY_BUCKET.put(manifestKey, JSON.stringify(eventRefs), {
        httpMetadata: { contentType: "application/json" },
      });
      return { manifestKey, eventCount: eventRefs.length, runDate };
    });

    const keys = classified.flatMap(({ year, eventRefs }) =>
      eventRefs.map(({ key, lifecycle }) => ({ year, key, lifecycle })));
    const initialized: string[] = [];
    const failures: Array<{ event_key: string; error: string }> = [];
    for (let offset = 0; offset < keys.length; offset += 10) {
      const batch = keys.slice(offset, offset + 10);
      const result = await step.do(`initialize-events-${offset / 10}`, {
        retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
      }, async () => {
        const batchInitialized: string[] = [];
        const batchFailures: Array<{ event_key: string; error: string }> = [];
        for (const item of batch) {
          const response = await this.env.FIELDVIEW_RUNTIME.fetch(new Request(
            "https://fieldview-runtime/internal/workflows/initialize-event",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.env.RUNTIME_ADMIN_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ event_key: item.key, ...item.lifecycle }),
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

    await step.do("publish-this-week-generation", async () => {
      const pointer = { runAt, runDate: prepared.runDate, years };
      await this.env.DISCOVERY_BUCKET.put(
        "projections/events/this-week/current.json",
        JSON.stringify(pointer),
        { httpMetadata: { contentType: "application/json" } },
      );
      return { published: true, eventCount: prepared.eventCount };
    });

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
  async fetch(request: Request, env: JobsEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ service: "fieldview-jobs", status: "ok" });
    if (url.pathname === "/internal/admin/daily-event-readiness" && request.method === "POST") {
      if (!env.RUNTIME_ADMIN_TOKEN ||
          request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const scheduledAt = Date.now();
      const id = `manual-event-readiness-${scheduledAt}`;
      await env.DAILY_EVENT_READINESS.create({ id, params: { scheduledAt } });
      return Response.json({ workflow_id: id, scheduled_at: scheduledAt }, { status: 202 });
    }
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
