import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { createDiscoveryStoreClient } from "./discovery-store.ts";
import type { TbaEvent } from "./calendar.ts";
import { buildEventsThisWeekProjection } from "./weekly-projection.ts";

type Env = RuntimeEnvironment;
export interface WeeklyEventProjectionParameters { requestedAt?: number; reason?: "scheduled" | "manual"; }
interface CurrentSeason { year: number; }
interface DirectoryResult { checkedAt: number; generation: number; chunkCount: number; needsChunking: boolean; }
interface DirectoryDocument { year: number; events: TbaEvent[]; }

export class WeeklyEventProjectionWorkflow extends WorkflowEntrypoint<Env, WeeklyEventProjectionParameters> {
  async run(event: WorkflowEvent<WeeklyEventProjectionParameters>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const evaluatedAt = Number.isSafeInteger(event.payload?.requestedAt)
      ? Number(event.payload?.requestedAt) : event.schedule?.scheduledTime ?? Date.now();
    const store = () => createDiscoveryStoreClient(this.env.DISCOVERY_STORE);
    const currentObject = await step.do("read-current-season", () => store().get("discovery/current-season.json"));
    const current = currentObject ? await currentObject.json<CurrentSeason>() : null;
    if (!current || !Number.isInteger(current.year) || current.year < 1992 || current.year > 2200) {
      throw new Error("The authoritative TBA current-season discovery record is unavailable");
    }
    const year = current.year;
    const directory = await step.do("refresh-event-directory", { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } }, async () => {
      const response = await store().catalog("discover-event-directory", { year, chunkSize: 25 });
      if (!response.ok) throw new Error("Event directory discovery returned HTTP " + response.status);
      return response.json() as Promise<DirectoryResult>;
    });
    if (directory.needsChunking) {
      for (let firstChunk = 0; firstChunk < directory.chunkCount; firstChunk += 10) {
        const endChunk = Math.min(directory.chunkCount, firstChunk + 10);
        await step.do("write-event-chunks-" + firstChunk, async () => {
          const response = await store().catalog("write-event-chunks", { year, generation: directory.generation, firstChunk, endChunk, chunkSize: 25 });
          if (!response.ok) throw new Error("Event chunk write returned HTTP " + response.status);
          return response.json();
        });
      }
      await step.do("publish-event-directory", async () => {
        const response = await store().catalog("publish-event-directory", { year, generation: directory.generation });
        if (!response.ok) throw new Error("Event directory publication returned HTTP " + response.status);
        return response.json();
      });
    }
    const events: TbaEvent[] = [];
    if (directory.needsChunking) {
      for (let index = 0; index < directory.chunkCount; index += 1) {
        const chunk = await step.do("read-event-chunk-" + index, async () => {
          const object = await store().get("discovery/event-chunks/" + year + "/" + directory.generation + "/" + index + ".json");
          if (!object) throw new Error("Missing event discovery chunk " + index);
          return object.json<TbaEvent[]>();
        });
        events.push(...chunk);
      }
    } else {
      const object = await step.do("read-event-directory", () => store().get("discovery/events/" + year + ".json"));
      const document = object ? await object.json<DirectoryDocument>() : null;
      if (!document || document.year !== year || !Array.isArray(document.events)) throw new Error("Published event directory is missing or invalid");
      events.push(...document.events);
    }
    const projection = buildEventsThisWeekProjection(events, year, evaluatedAt, directory.checkedAt);
    await step.do("publish-events-this-week", () => store().put("projections/events-this-week/current.json", JSON.stringify(projection)));
    return { workflow_id: event.instanceId, reason: event.payload?.reason ?? "scheduled", year, evaluated_at: evaluatedAt,
      week_start: projection.weekStart, week_end: projection.weekEnd, discovered_events: events.length, candidate_events: projection.events.length };
  }
}
