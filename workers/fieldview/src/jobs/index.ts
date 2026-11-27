import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { dispatchRuntime } from "../runtime/runtime-dispatch.ts";

import { isValidEventLifecycleInput, lifecycleFor } from "./calendar.ts";
import type { TbaEvent } from "./calendar.ts";
import { RuntimeAdminWorkflow } from "./runtime-admin.ts";
import { PollingCoordinatorWorkflow } from "./polling-coordinator.ts";
import { WeeklyEventProjectionWorkflow } from "./weekly-event-projection.ts";
import { EventAnalyticsWorkflow } from "./event-analytics.ts";
export { PollingCoordinatorWorkflow, WeeklyEventProjectionWorkflow, EventAnalyticsWorkflow };
import { createDiscoveryServiceClient, type DiscoveryServiceClient } from "./discovery-client.ts";
import type { RuntimeAdminParameters } from "./runtime-admin.ts";
import { EventSeasonReadinessWorkflow, TeamSeasonReadinessWorkflow, SeasonStatusResolverWorkflow } from "./season-readiness.ts";
import type { SeasonEnvironment } from "./season-readiness.ts";
export { EventSeasonReadinessWorkflow, TeamSeasonReadinessWorkflow, SeasonStatusResolverWorkflow };
export { RuntimeAdminWorkflow };

interface DiscoveryDocument {
  year: number;
  events: TbaEvent[];
  chunkCount: number;
  etag: string | null;
  updatedAt: number;
  checkedAt: number;
}

interface JobsEnvironment extends RuntimeEnvironment, SeasonEnvironment {
  COVERAGE_AUDIT: Workflow;
  RUNTIME_ADMIN: Workflow;
  POLLING_COORDINATOR?: Workflow;
  WEEKLY_EVENT_PROJECTION?: Workflow;
  EVENT_ANALYTICS_WORKFLOW?: Workflow;
}

interface WorkflowParameters {
  scheduledAt?: number;
  operation?: "discover-season";
  year?: number;
  requestedAt?: number;
  jobId?: string;
}

interface AdminDiscoveryJobRecord {
  year: number;
  mode: "year";
  workflow_id: string;
  status: "running" | "completed" | "partial" | "failed";
  stage: string;
  events: number;
  teams: number;
  team_pages: number;
  expected_team_pages?: number;
  failed_team_pages?: number[];
  warnings?: string[];
  team_directory_complete?: boolean;
  team_generation?: number;
  steps: number;
  error: string | null;
  started_at: number;
  updated_at: number;
}

async function readJson<T>(bucket: DiscoveryServiceClient, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? object.json<T>() : null;
}

async function listRuntimeRegistry(bucket: DiscoveryServiceClient, kind: "event" | "team"): Promise<string[]> {
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      const key = object.key.slice(prefix.length).replace(/\.json$/, "");
      if (key) keys.push(key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}


/**
 * Discovery owns first-time Durable Object registration. Existing markers are
 * read once; only missing identities receive a DO initialization request and a
 * corresponding discovery marker. Registration binds identity only—it never
 * acquires provider data or schedules background work.
 */
async function registerDiscoveredRuntimes(
  env: JobsEnvironment,
  bucket: DiscoveryServiceClient,
  step: WorkflowStep,
  kind: "event" | "team",
  keys: string[],
  operationPrefix: string,
): Promise<{ registered: number; initialized: number }> {
  const namespace = kind === "event" ? env.EVENT_RUNTIME : env.TEAM_RUNTIME;
  if (!namespace) throw new Error(kind + " runtime namespace is unavailable");
  const markerPrefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  const existing = new Set(await step.do(operationPrefix + "-read-registration-markers", async () =>
    listRuntimeRegistry(bucket, kind)));
  const validKeys = [...new Set(keys)].filter((key) =>
    kind === "event" ? /^[a-zA-Z0-9_-]+$/.test(key) : /^frc[0-9]+$/.test(key));
  const missing = validKeys.filter((key) => !existing.has(key));
  let initialized = 0;
  for (let offset = 0; offset < missing.length; offset += 25) {
    const chunk = missing.slice(offset, offset + 25);
    await step.do(operationPrefix + "-initialize-" + String(offset / 25).padStart(4, "0"), async () => {
      let count = 0;
      for (const key of chunk) {
        const stub = namespace.get(namespace.idFromName(key));
        const identityHeader = kind === "event" ? "X-FieldView-Event-Key" : "X-FieldView-Team-Key";
        const response = await stub.fetch(new Request("https://" + kind + "-runtime/register", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
            [identityHeader]: key,
          },
        }));
        if (!response.ok) {
          throw new Error(kind + " runtime registration failed for " + key + " with HTTP " +
            response.status + ": " + (await response.text()).slice(0, 300));
        }
        await bucket.put(markerPrefix + key + ".json", "{}", {
          httpMetadata: { contentType: "application/json" },
        });
        count += 1;
      }
      return { initialized: count };
    });
    initialized += chunk.length;
  }
  return { registered: validKeys.length, initialized };
}

async function readPublishedSeason(bucket: DiscoveryServiceClient, year: number): Promise<{
  events: TbaEvent[];
  eventUpdatedAt: number;
  teamKeys: string[];
  teamPageCount: number;
  teamUpdatedAt: number;
} | null> {
  const events = await readJson<DiscoveryDocument>(bucket, `discovery/events/${year}.json`);
  const teamManifest = await readJson<{
    year: number; generation: number; pageCount: number; teamCount: number; updatedAt: number; complete?: boolean;
  }>(bucket, `discovery/teams/${year}.json`);
  const teamKeys = await readJson<string[]>(bucket, `registry/teams/${year}.json`);
  if (!events || events.year !== year || !Array.isArray(events.events) ||
      events.events.some((item) => !item || typeof item.key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.key)) ||
      !teamManifest || teamManifest.complete !== true || teamManifest.year !== year || !Number.isInteger(teamManifest.pageCount) ||
      teamManifest.pageCount < 1 || !Number.isInteger(teamManifest.teamCount) ||
      !Array.isArray(teamKeys) || teamKeys.length !== teamManifest.teamCount ||
      teamKeys.some((key) => typeof key !== "string" || !/^frc[0-9]+$/.test(key))) return null;
  return {
    events: events.events, eventUpdatedAt: events.updatedAt,
    teamKeys, teamPageCount: teamManifest.pageCount, teamUpdatedAt: teamManifest.updatedAt,
  };
}

type CoverageAuditCounts = {
  events_total: number; events_happened: number; events_active: number; events_upcoming: number; events_invalid_dates: number;
  teams_total: number; team_pages: number; event_runtime_missing: number; team_runtime_missing: number;
  event_state_complete: number; event_state_partial: number; event_state_stale: number; event_state_missing: number; event_state_failed: number;
  event_analytics_succeeded: number; event_analytics_partial: number; event_analytics_stale: number; event_analytics_waiting: number; event_analytics_missing: number; event_analytics_failed: number;
  event_cohort_complete: number; event_cohort_partial: number; event_cohort_discovering: number; event_cohort_missing: number;
  team_snapshot_complete: number; team_snapshot_partial: number; team_snapshot_missing: number; team_snapshot_failed: number;
  event_resources_incomplete: number; team_resources_incomplete: number; read_errors: number;
};
type CoverageAuditItem = { kind: "event" | "team"; key: string; registered: boolean };
interface CoverageAuditRecord {
  year: number; workflow_id: string; status: "running" | "completed" | "stale" | "failed" | "cancelled";
  started_at: number; updated_at: number; cursor: number; total: number;
  event_discovery_updated_at: number; team_discovery_updated_at: number;
  items_prefix: string; counts: CoverageAuditCounts; error: string | null;
}
interface CoverageAuditParameters { year: number; workflowId: string; startedAt: number; }

/** Manual season-discovery Workflow base; bulk daily readiness is disabled. */
export class SeasonDiscoveryWorkflowBase extends WorkflowEntrypoint<JobsEnvironment, WorkflowParameters> {
  async run(event: WorkflowEvent<WorkflowParameters>, step: WorkflowStep): Promise<Record<string, unknown>> {
    if (event.payload?.operation !== "discover-season") {
      throw new Error("Legacy bulk readiness execution is disabled");
    }
    return this.discoverSeason(event.payload, step);
  }

  private async discoverSeason(
    payload: WorkflowParameters,
    step: WorkflowStep,
  ): Promise<Record<string, unknown>> {
    const year = payload.year;
    const jobId = payload.jobId;
    const requestedAt = payload.requestedAt;
    if (!Number.isInteger(year) || year! < 1992 || year! > 2200 || !jobId || !requestedAt) {
      throw new Error("Manual season discovery requires a valid year, job ID, and request timestamp");
    }
    const season = year!;
    const jobKey = `admin/discovery-jobs/${season}.json`;
    const updateJob = async (name: string, patch: Partial<AdminDiscoveryJobRecord>) =>
      step.do(name, async () => {
        const current = await readJson<AdminDiscoveryJobRecord>(createDiscoveryServiceClient(this.env), jobKey);
        const defaults: AdminDiscoveryJobRecord = {
          year: season, mode: "year", workflow_id: jobId, status: "running", stage: "starting",
          events: 0, teams: 0, team_pages: 0, expected_team_pages: 0, failed_team_pages: [], warnings: [],
          team_directory_complete: false, steps: 0, error: null,
          started_at: requestedAt, updated_at: Date.now(),
        };
        const next: AdminDiscoveryJobRecord = {
          ...defaults, ...(current ?? {}), ...patch,
          ...{ workflow_id: jobId, year: season, updated_at: Date.now() },
        };
        await createDiscoveryServiceClient(this.env).put(jobKey, JSON.stringify(next), {
          httpMetadata: { contentType: "application/json" },
        });
        return next;
      });

    try {
      // Canonical season status is resolved by its own Workflow and persisted
      // in KV. Discovery only consumes the last resolved max_team_page bound.
      const tbaStatus = await step.do("read-canonical-season-status", async () => {
        const raw = await this.env.KV_BINDING?.get("system/canonical-season.json");
        if (!raw) throw new Error("Canonical season status is missing; run the season status resolver first");
        const resolved = JSON.parse(raw) as { year?: unknown; maxTeamPage?: unknown };
        if (!Number.isInteger(resolved.year) || Number(resolved.year) < 1992 || Number(resolved.year) > 2200 ||
            !Number.isInteger(resolved.maxTeamPage) || Number(resolved.maxTeamPage) < 0) {
          throw new Error("Persisted canonical season status is invalid or missing max_team_page");
        }
        return { year: Number(resolved.year), maxTeamPage: Number(resolved.maxTeamPage) };
      });
      await updateJob("record-discovery-started", { stage: "discovering_events" });
      const generation = await step.do("allocate-season-directory-generation", async () => Date.now());
      const eventChunkSize = 25;
      const eventDirectory = await step.do("discover-manual-season-events", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
        const response = await createDiscoveryServiceClient(this.env).catalog("discover-event-directory", {
          year: season, generation, chunkSize: eventChunkSize,
        });
        if (!response.ok) throw new Error("Discovery service event directory acquisition returned HTTP " + response.status);
        return response.json() as Promise<{
          year: number; count: number; checkedAt: number; generation: number;
          chunkCount: number; needsChunking: boolean;
        }>;
      });
      await updateJob("record-event-discovery-progress", {
        stage: "publishing_events", events: eventDirectory.count, steps: 2,
      });

      if (eventDirectory.needsChunking) {
        for (let firstChunk = 0; firstChunk < eventDirectory.chunkCount; firstChunk += 10) {
          const endChunk = Math.min(eventDirectory.chunkCount, firstChunk + 10);
          await step.do(`write-manual-event-chunks-${firstChunk}`, async () => {
            const response = await createDiscoveryServiceClient(this.env).catalog("write-event-chunks", {
              year: season, generation: eventDirectory.generation,
              firstChunk, endChunk, chunkSize: eventChunkSize,
            });
            if (!response.ok) throw new Error("Discovery service event chunk write returned HTTP " + response.status);
            return response.json();
          });
        }
        await step.do("publish-manual-event-directory", async () => {
          const response = await createDiscoveryServiceClient(this.env).catalog("publish-event-directory", {
            year: season, generation: eventDirectory.generation,
          });
          if (!response.ok) throw new Error("Discovery service event directory publication returned HTTP " + response.status);
          return response.json();
        });
      }

      const expectedTeamPages = tbaStatus.maxTeamPage + 1;
      const resume = await step.do("find-resumable-team-directory", async () => {
        const response = await createDiscoveryServiceClient(this.env).catalog("resume-partial-team-directory", {
          year: season, expectedPageCount: expectedTeamPages,
        });
        if (!response.ok) throw new Error("Discovery service partial directory lookup returned HTTP " + response.status);
        return response.json() as Promise<{
          resumable: boolean; generation?: number; teamKeys?: string[]; failedPages?: number[]; warnings?: string[];
        }>;
      });
      const teamGeneration = resume.resumable && Number.isSafeInteger(resume.generation)
        ? Number(resume.generation)
        : await step.do("allocate-manual-team-directory-generation", async () => Date.now());
      const teamKeys: string[] = [...(resume.resumable ? resume.teamKeys ?? [] : [])];
      const failedTeamPages: number[] = [...(resume.resumable ? resume.failedPages ?? [] : [])];
      const failedPageSet = new Set(failedTeamPages);
      const warnings: string[] = [...(resume.resumable ? resume.warnings ?? [] : [])];
      let teamPages = resume.resumable ? expectedTeamPages - failedTeamPages.length : 0;
      for (let page = 0; page <= tbaStatus.maxTeamPage; page += 1) {
        if (resume.resumable && !failedPageSet.has(page)) continue;
        try {
          const result = await step.do(`discover-manual-team-page-${page}`, {
            retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
          }, async () => {
            const response = await createDiscoveryServiceClient(this.env).catalog("discover-team-page", {
              year: season, generation: teamGeneration, page,
            });
            if (!response.ok) throw new Error("Discovery service team page acquisition returned HTTP " + response.status);
            return response.json() as Promise<{ teamKeys: string[]; count: number }>;
          });
          teamKeys.push(...result.teamKeys);
          failedPageSet.delete(page);
          teamPages += 1;
        } catch (error) {
          failedPageSet.add(page);
          warnings.push(`Team page ${page} failed after retries: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
        }
      }
      failedTeamPages.splice(0, failedTeamPages.length, ...[...failedPageSet].sort((a, b) => a - b));
      const uniqueTeamKeys = [...new Set(teamKeys)].sort();
      if (failedTeamPages.length === 0 && uniqueTeamKeys.length === 0) {
        throw new Error("TBA returned an empty team directory for the selected season");
      }
      await updateJob("record-team-discovery-progress", {
        stage: "publishing_teams", teams: uniqueTeamKeys.length, team_pages: teamPages,
        expected_team_pages: expectedTeamPages, failed_team_pages: failedTeamPages,
        warnings, team_directory_complete: failedTeamPages.length === 0, team_generation: teamGeneration,
        steps: 3 + expectedTeamPages,
      });
      const publication = await step.do("publish-manual-team-directory", async () => {
        const response = await createDiscoveryServiceClient(this.env).catalog("publish-team-directory", {
          year: season, generation: teamGeneration, pageCount: expectedTeamPages,
          teamKeys: uniqueTeamKeys, failedPages: failedTeamPages, warnings,
        });
        if (!response.ok) throw new Error("Discovery service team directory publication returned HTTP " + response.status);
        return response.json() as Promise<{ status: "completed" | "partial"; complete: boolean }>;
      });
      if (publication.complete) {
        await registerDiscoveredRuntimes(this.env, createDiscoveryServiceClient(this.env), step,
          "team", uniqueTeamKeys, "manual-discovery-team-runtime-registration");
      }
      const publishedEvents = await readJson<DiscoveryDocument>(
        createDiscoveryServiceClient(this.env), `discovery/events/${season}.json`);
      await registerDiscoveredRuntimes(this.env, createDiscoveryServiceClient(this.env), step,
        "event", (publishedEvents?.events ?? []).map((item) => item.key),
        "manual-discovery-event-runtime-registration");
      const partial = publication.status === "partial";
      const summary = {
        year: season, mode: "year", workflow_id: jobId, status: partial ? "partial" : "completed",
        stage: partial ? "partial" : "complete",
        events: eventDirectory.count, teams: uniqueTeamKeys.length, team_pages: teamPages,
        expected_team_pages: expectedTeamPages, failed_team_pages: failedTeamPages,
        warnings, team_directory_complete: publication.complete, team_generation: teamGeneration,
        steps: 4 + expectedTeamPages + (eventDirectory.needsChunking ? Math.ceil(eventDirectory.chunkCount / 10) + 1 : 0),
        error: null, started_at: requestedAt, updated_at: Date.now(),
      };
      await step.do("publish-manual-discovery-summary", async () => {
        await createDiscoveryServiceClient(this.env).put(jobKey, JSON.stringify(summary), {
          httpMetadata: { contentType: "application/json" },
        });
        return summary;
      });
      return summary;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await step.do("record-manual-discovery-failure", async () => {
        const current = await readJson<AdminDiscoveryJobRecord>(createDiscoveryServiceClient(this.env), jobKey);
        const failed: AdminDiscoveryJobRecord = {
          year: season, mode: "year", workflow_id: jobId, status: "failed", stage: current?.stage ?? "failed",
          events: current?.events ?? 0, teams: current?.teams ?? 0, team_pages: current?.team_pages ?? 0,
          expected_team_pages: current?.expected_team_pages, failed_team_pages: current?.failed_team_pages,
          warnings: current?.warnings, team_directory_complete: current?.team_directory_complete ?? false,
          team_generation: current?.team_generation, steps: current?.steps ?? 0, error: detail.slice(0, 500),
          started_at: requestedAt, updated_at: Date.now(),
        };
        await createDiscoveryServiceClient(this.env).put(jobKey, JSON.stringify(failed), {
          httpMetadata: { contentType: "application/json" },
        });
        return failed;
      });
      throw error;
    }
  }
}


/** Explicit, year-parameterized discovery Workflow; it does not resolve canonical season. */
export class SeasonDiscoveryWorkflow extends SeasonDiscoveryWorkflowBase {}

/**
 * Sequential readiness sweep. The Workflow never acquires entity resources:
 * each runtime inspects its own durable publication; the coordinator owns refresh dispatch.
 */
export class DailyEventReadinessWorkflow extends SeasonDiscoveryWorkflowBase {
  override async run(
    event: WorkflowEvent<WorkflowParameters>,
    step: WorkflowStep,
  ): Promise<Record<string, unknown>> {
    // Preserve the explicit admin season-discovery operation. The legacy class
    // handles only that separate operation; the daily path below is replaced.
    if (event.payload?.operation === "discover-season") return super.run(event, step);

    const runAt = event.payload?.scheduledAt ?? event.schedule?.scheduledTime ?? Date.now();
    const runDate = new Date(runAt).toISOString().slice(0, 10);
    const runId = event.instanceId;
    const store = () => createDiscoveryServiceClient(this.env);
    const runPrefix = `admin/workflow-runs/event-readiness/${runId}`;
    const runRecordKey = `${runPrefix}/record.json`;
    const runRecord = {
      workflow_id: runId, workflow_type: "event-readiness", status: "running",
      started_at: runAt, updated_at: Date.now(), completed_at: null,
      year: null as number | null, total: 0, summary: null as Record<string, unknown> | null,
      result_chunks: 0, error: null as string | null,
    };
    await step.do("readiness-persist-run-start", async () => {
      await store().put(runRecordKey, JSON.stringify(runRecord), { httpMetadata: { contentType: "application/json" } });
      await store().put(`admin/workflow-runs/index/event-readiness/${String(runAt).padStart(16, "0")}-${runId}.json`,
        JSON.stringify({ workflow_id: runId, workflow_type: "event-readiness", started_at: runAt, year: null }),
        { httpMetadata: { contentType: "application/json" } });
      return { workflow_id: runId, status: "running" };
    });

    const currentSeason = await step.do("readiness-resolve-current-season", {
      retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
    }, async () => {
      const response = await store().catalog("resolve-current-season");
      if (!response.ok) throw new Error("Current-season resolution returned HTTP " + response.status);
      return response.json() as Promise<{ year: number; checkedAt: number; maxTeamPage?: number; fallback?: boolean }>;
    });
    const year = currentSeason.year;
    await step.do("readiness-persist-season", async () => {
      runRecord.year = year;
      runRecord.updated_at = Date.now();
      await store().put(runRecordKey, JSON.stringify(runRecord), { httpMetadata: { contentType: "application/json" } });
      return { year };
    });

    // Acquire and publish the TBA event directory. Chunk writes are discovery
    // storage operations, not fan-out to entity runtimes.
    const eventDirectory = await step.do("readiness-discover-event-directory", {
      retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
    }, async () => {
      const response = await store().catalog("discover-event-directory", { year, chunkSize: 25 });
      if (!response.ok) throw new Error("Event directory discovery returned HTTP " + response.status);
      return response.json() as Promise<{
        year: number; count: number; checkedAt: number; generation: number;
        chunkCount: number; needsChunking: boolean;
      }>;
    });
    if (eventDirectory.needsChunking) {
      for (let firstChunk = 0; firstChunk < eventDirectory.chunkCount; firstChunk += 10) {
        const endChunk = Math.min(eventDirectory.chunkCount, firstChunk + 10);
        await step.do("readiness-write-event-chunks-" + firstChunk, async () => {
          const response = await store().catalog("write-event-chunks", {
            year, generation: eventDirectory.generation, firstChunk, endChunk, chunkSize: 25,
          });
          if (!response.ok) throw new Error("Event chunk write returned HTTP " + response.status);
          return response.json();
        });
      }
      await step.do("readiness-publish-event-directory", async () => {
        const response = await store().catalog("publish-event-directory", {
          year, generation: eventDirectory.generation,
        });
        if (!response.ok) throw new Error("Event directory publication returned HTTP " + response.status);
        return response.json();
      });
    }

    const eventKeys: TbaEvent[] = [];
    if (eventDirectory.needsChunking) {
      for (let chunkIndex = 0; chunkIndex < eventDirectory.chunkCount; chunkIndex += 1) {
        const chunk = await step.do("readiness-read-event-chunk-" + chunkIndex, async () => {
          const object = await store().get(
            `discovery/event-chunks/${year}/${eventDirectory.generation}/${chunkIndex}.json`,
          );
          if (!object) throw new Error("Missing event discovery chunk " + chunkIndex);
          return object.json<TbaEvent[]>();
        });
        eventKeys.push(...chunk);
      }
    } else {
      const directory = await step.do("readiness-read-event-directory", async () => {
        const value = await store().get(`discovery/events/${year}.json`);
        if (!value) throw new Error("Published event directory is missing");
        return value.json<DiscoveryDocument>();
      });
      eventKeys.push(...directory.events);
    }

    await registerDiscoveredRuntimes(this.env, store(), step, "event",
      eventKeys.map((item) => item.key), "readiness-event-runtime-registration");

    const registeredEventKeys = new Set(await step.do(
      "readiness-list-registered-event-runtimes",
      async () => listRuntimeRegistry(store(), "event"),
    ));
    const registeredEventCount = eventKeys.filter((item) =>
      item && typeof item.key === "string" && registeredEventKeys.has(item.key),
    ).length;
    const eventResults: Array<{
      key: string; state_valid: boolean; refresh_required: boolean; refresh_dispatched: boolean;
      stale_sources?: string[]; error?: string;
    }> = [];
    for (const item of eventKeys) {
      if (!item || typeof item.key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.key) ||
          !registeredEventKeys.has(item.key)) continue;
      try {
        const result = await step.do("readiness-event-" + item.key, {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        }, async () => {
          const response = await dispatchRuntime(this.env, "event", item.key, "readiness", {}, year);
          if (!response.ok) throw new Error("EventRuntime readiness returned HTTP " + response.status + ": " + await response.text());
          return response.json() as Promise<{
            state_valid?: boolean; refresh_required?: boolean; refresh_dispatched?: boolean; stale_sources?: string[];
          }>;
        });
        eventResults.push({
          key: item.key,
          state_valid: result.state_valid === true,
          refresh_required: result.refresh_required === true,
          refresh_dispatched: result.refresh_dispatched === true,
          stale_sources: result.stale_sources ?? [],
        });
      } catch (error) {
        eventResults.push({ key: item.key, state_valid: false, refresh_required: false, refresh_dispatched: false, error: String(error).slice(0, 300) });
      }
    }

    const summary = {
      run_date: runDate,
      current_season: year,
      season_source: currentSeason.fallback ? "last-known-good" : "tba-status",
      events_total: eventKeys.length,
      events_registered: registeredEventCount,
      events_unregistered: eventKeys.length - registeredEventCount,
      events_state_valid: eventResults.filter((item) => item.state_valid).length,
      events_refresh_required: eventResults.filter((item) => item.refresh_required).length,
      events_failed: eventResults.filter((item) => item.error).length,
      event_failures: eventResults.filter((item) => item.error).slice(0, 100),
      event_readiness: eventResults,
      event_directory: { count: eventDirectory.count, generation: eventDirectory.generation },
    };
    const summaryRecord = {
      run_date: summary.run_date, current_season: summary.current_season, season_source: summary.season_source,
      events_total: summary.events_total, events_registered: summary.events_registered,
      events_unregistered: summary.events_unregistered, events_state_valid: summary.events_state_valid,
      events_refresh_required: summary.events_refresh_required, events_failed: summary.events_failed,
      event_directory: summary.event_directory,
    };
    const resultChunks = Math.ceil(eventResults.length / 25);
    await step.do("readiness-write-run-results", async () => {
      for (let offset = 0; offset < eventResults.length; offset += 25) {
        const chunk = eventResults.slice(offset, offset + 25);
        await store().put(`${runPrefix}/results/${String(Math.floor(offset / 25)).padStart(4, "0")}.json`,
          JSON.stringify({ offset, results: chunk }), { httpMetadata: { contentType: "application/json" } });
      }
      await store().put(`${runPrefix}/summary.json`, JSON.stringify(summaryRecord), {
        httpMetadata: { contentType: "application/json" },
      });
      const completed = {
        ...runRecord, status: summary.events_failed ? "completed_with_errors" : "completed",
        updated_at: Date.now(), completed_at: Date.now(), year, total: eventResults.length,
        summary: {
          events_total: summary.events_total, events_state_valid: summary.events_state_valid,
          events_refresh_required: summary.events_refresh_required, events_failed: summary.events_failed,
        },
        result_chunks: resultChunks, error: null,
      };
      await store().put(runRecordKey, JSON.stringify(completed), { httpMetadata: { contentType: "application/json" } });
      await store().put(`admin/workflow-runs/index/event-readiness/${String(runAt).padStart(16, "0")}-${runId}.json`,
        JSON.stringify({ workflow_id: runId, workflow_type: "event-readiness", started_at: runAt, completed_at: completed.completed_at, year, status: completed.status }),
        { httpMetadata: { contentType: "application/json" } });
      await store().put(`workflows/daily-event-readiness/${runAt}/summary.json`, JSON.stringify(summary), {
        httpMetadata: { contentType: "application/json" },
      });
      return completed;
    });
    return summary;
  }
}

/**
 * Independent sequential TeamRuntime readiness sweep. It owns only the team
 * discovery directory and TeamRuntime readiness; it never scans EventRuntime.
 */
export class DailyTeamReadinessWorkflow extends WorkflowEntrypoint<JobsEnvironment, WorkflowParameters> {
  async run(event: WorkflowEvent<WorkflowParameters>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const runAt = event.payload?.scheduledAt ?? event.schedule?.scheduledTime ?? Date.now();
    const runDate = new Date(runAt).toISOString().slice(0, 10);
    const runId = event.instanceId;
    const store = () => createDiscoveryServiceClient(this.env);
    const runPrefix = `admin/workflow-runs/team-readiness/${runId}`;
    const runRecordKey = `${runPrefix}/record.json`;
    const runRecord = {
      workflow_id: runId, workflow_type: "team-readiness", status: "running",
      started_at: runAt, updated_at: Date.now(), completed_at: null,
      year: null as number | null, total: 0, summary: null as Record<string, unknown> | null,
      result_chunks: 0, error: null as string | null,
    };
    await step.do("team-readiness-persist-run-start", async () => {
      await store().put(runRecordKey, JSON.stringify(runRecord), { httpMetadata: { contentType: "application/json" } });
      await store().put(`admin/workflow-runs/index/team-readiness/${String(runAt).padStart(16, "0")}-${runId}.json`,
        JSON.stringify({ workflow_id: runId, workflow_type: "team-readiness", started_at: runAt, year: null }),
        { httpMetadata: { contentType: "application/json" } });
      return { workflow_id: runId, status: "running" };
    });

    const currentSeason = await step.do("team-readiness-resolve-current-season", {
      retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
    }, async () => {
      const response = await store().catalog("resolve-current-season");
      if (!response.ok) throw new Error("Current-season resolution returned HTTP " + response.status);
      return response.json() as Promise<{ year: number; checkedAt: number; maxTeamPage?: number; fallback?: boolean }>;
    });
    const year = currentSeason.year;
    await step.do("team-readiness-persist-season", async () => {
      runRecord.year = year;
      runRecord.updated_at = Date.now();
      await store().put(runRecordKey, JSON.stringify(runRecord), { httpMetadata: { contentType: "application/json" } });
      return { year };
    });

    // Team Discovery is refreshed and published independently of Event Discovery.
    // Use TBA's authoritative maximum page index; page indexes are inclusive.
    const maxTeamPage = currentSeason.maxTeamPage;
    if (!Number.isInteger(maxTeamPage) || maxTeamPage! < 0) {
      throw new Error("TBA status did not provide a valid max_team_page; team readiness cannot determine its page range");
    }
    const expectedTeamPages = maxTeamPage! + 1;
    const teamGeneration = await step.do("team-readiness-directory-generation", async () => Date.now());
    const teamKeys: string[] = [];
    let teamPages = 0;
    for (let page = 0; page <= maxTeamPage!; page += 1) {
      const result = await step.do("team-readiness-discover-page-" + page, {
        retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
        const response = await store().catalog("discover-team-page", { year, generation: teamGeneration, page });
        if (!response.ok) throw new Error("Team directory page returned HTTP " + response.status);
        return response.json() as Promise<{ teamKeys: string[]; count: number }>;
      });
      teamPages += 1;
      teamKeys.push(...result.teamKeys);
    }
    if (teamPages !== expectedTeamPages) {
      throw new Error(`Team readiness fetched ${teamPages} of ${expectedTeamPages} expected TBA pages`);
    }
    const uniqueTeamKeys = [...new Set(teamKeys)].sort();
    if (uniqueTeamKeys.length === 0) throw new Error("TBA returned an empty team directory for the canonical current season");
    await step.do("team-readiness-publish-directory", async () => {
      const response = await store().catalog("publish-team-directory", {
        year, generation: teamGeneration, pageCount: teamPages, teamKeys: uniqueTeamKeys,
      });
      if (!response.ok) throw new Error("Team directory publication returned HTTP " + response.status);
      return response.json();
    });

    await registerDiscoveredRuntimes(this.env, store(), step, "team",
      uniqueTeamKeys, "team-readiness-runtime-registration");

    const registeredTeamKeys = new Set(await step.do(
      "team-readiness-list-registered-team-runtimes",
      async () => listRuntimeRegistry(store(), "team"),
    ));
    const registeredTeamKeyList = uniqueTeamKeys.filter((teamKey) => registeredTeamKeys.has(teamKey));
    const teamResults: Array<{
      key: string; state_valid: boolean; refresh_required: boolean; refresh_dispatched: boolean;
      stale_resources?: string[]; error?: string;
    }> = [];
    for (const teamKey of registeredTeamKeyList) {
      try {
        const result = await step.do("team-readiness-" + teamKey, {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        }, async () => {
          const response = await dispatchRuntime(this.env, "team", teamKey, "readiness", {}, year);
          if (!response.ok) throw new Error("TeamRuntime readiness returned HTTP " + response.status + ": " + await response.text());
          return response.json() as Promise<{
            state_valid?: boolean; refresh_required?: boolean; refresh_dispatched?: boolean; stale_resources?: string[];
          }>;
        });
        teamResults.push({
          key: teamKey,
          state_valid: result.state_valid === true,
          refresh_required: result.refresh_required === true,
          refresh_dispatched: result.refresh_dispatched === true,
          stale_resources: result.stale_resources ?? [],
        });
      } catch (error) {
        teamResults.push({ key: teamKey, state_valid: false, refresh_required: false, refresh_dispatched: false, error: String(error).slice(0, 300) });
      }
    }

    const summary = {
      run_date: runDate,
      current_season: year,
      season_source: currentSeason.fallback ? "last-known-good" : "tba-status",
      teams_total: uniqueTeamKeys.length,
      teams_registered: registeredTeamKeyList.length,
      teams_unregistered: uniqueTeamKeys.length - registeredTeamKeyList.length,
      teams_state_valid: teamResults.filter((item) => item.state_valid).length,
      teams_refresh_required: teamResults.filter((item) => item.refresh_required).length,
      teams_failed: teamResults.filter((item) => item.error).length,
      team_failures: teamResults.filter((item) => item.error).slice(0, 100),
      team_readiness: teamResults,
      team_directory: { pages: teamPages, teams: uniqueTeamKeys.length },
    };
    const summaryRecord = {
      run_date: summary.run_date, current_season: summary.current_season, season_source: summary.season_source,
      teams_total: summary.teams_total, teams_registered: summary.teams_registered,
      teams_unregistered: summary.teams_unregistered, teams_state_valid: summary.teams_state_valid,
      teams_refresh_required: summary.teams_refresh_required, teams_failed: summary.teams_failed,
      team_directory: summary.team_directory,
    };
    const resultChunks = Math.ceil(teamResults.length / 25);
    await step.do("team-readiness-write-run-results", async () => {
      for (let offset = 0; offset < teamResults.length; offset += 25) {
        const chunk = teamResults.slice(offset, offset + 25);
        await store().put(`${runPrefix}/results/${String(Math.floor(offset / 25)).padStart(4, "0")}.json`,
          JSON.stringify({ offset, results: chunk }), { httpMetadata: { contentType: "application/json" } });
      }
      await store().put(`${runPrefix}/summary.json`, JSON.stringify(summaryRecord), {
        httpMetadata: { contentType: "application/json" },
      });
      const completed = {
        ...runRecord, status: summary.teams_failed ? "completed_with_errors" : "completed",
        updated_at: Date.now(), completed_at: Date.now(), year, total: teamResults.length,
        summary: {
          teams_total: summary.teams_total, teams_state_valid: summary.teams_state_valid,
          teams_refresh_required: summary.teams_refresh_required, teams_failed: summary.teams_failed,
        },
        result_chunks: resultChunks, error: null,
      };
      await store().put(runRecordKey, JSON.stringify(completed), { httpMetadata: { contentType: "application/json" } });
      await store().put(`admin/workflow-runs/index/team-readiness/${String(runAt).padStart(16, "0")}-${runId}.json`,
        JSON.stringify({ workflow_id: runId, workflow_type: "team-readiness", started_at: runAt, completed_at: completed.completed_at, year, status: completed.status }),
        { httpMetadata: { contentType: "application/json" } });
      await store().put(`workflows/daily-team-readiness/${runAt}/summary.json`, JSON.stringify(summary), {
        httpMetadata: { contentType: "application/json" },
      });
      return completed;
    });
    return summary;
  }
}

export class CoverageAuditWorkflow extends WorkflowEntrypoint<JobsEnvironment, CoverageAuditParameters> {
  async run(event: WorkflowEvent<CoverageAuditParameters>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const { year, workflowId, startedAt } = event.payload;
    if (!Number.isInteger(year) || year < 1992 || year > 2200 || !workflowId || !startedAt) {
      throw new Error("Coverage audit requires a valid season, Workflow ID, and start timestamp");
    }
    const auditKey = `admin/coverage-audits/${year}.json`;
    const itemsPrefix = `admin/coverage-audit-items/${year}/${workflowId}/`;
    try {
      const prepared = await step.do("prepare-coverage-audit", async () => {
        const directory = await readPublishedSeason(createDiscoveryServiceClient(this.env), year);
        if (!directory) throw new Error("Complete event and paginated team discovery is required before starting the coverage audit");
        const now = Date.now();
        const runtimeEvents = new Set(await listRuntimeRegistry(createDiscoveryServiceClient(this.env), "event"));
        const runtimeTeams = new Set(await listRuntimeRegistry(createDiscoveryServiceClient(this.env), "team"));
        const items: CoverageAuditItem[] = [
          ...directory.events
            .filter((item) => {
              const lifecycle = lifecycleFor(item, now).lifecycle;
              return isValidEventLifecycleInput(item) && lifecycle !== "expired" &&
                typeof item.key === "string" && /^[a-zA-Z0-9_-]+$/.test(item.key);
            })
            .map((item) => ({ kind: "event" as const, key: item.key, registered: runtimeEvents.has(item.key) })),
          ...directory.teamKeys.map((key) => ({ kind: "team" as const, key, registered: runtimeTeams.has(key) })),
        ];
        if (items.length > 8_000) {
          throw new Error("Coverage audit exceeds the 8,000-entity Free-plan step budget; split the audit into smaller scopes");
        }
        const counts: CoverageAuditCounts = {
          events_total: directory.events.length, events_happened: 0, events_active: 0, events_upcoming: 0, events_invalid_dates: 0,
          teams_total: directory.teamKeys.length, team_pages: directory.teamPageCount,
          event_runtime_missing: 0, team_runtime_missing: 0,
          event_state_complete: 0, event_state_partial: 0, event_state_stale: 0, event_state_missing: 0, event_state_failed: 0,
          event_analytics_succeeded: 0, event_analytics_partial: 0, event_analytics_stale: 0, event_analytics_waiting: 0, event_analytics_missing: 0, event_analytics_failed: 0,
          event_cohort_complete: 0, event_cohort_partial: 0, event_cohort_discovering: 0, event_cohort_missing: 0,
          team_snapshot_complete: 0, team_snapshot_partial: 0, team_snapshot_missing: 0, team_snapshot_failed: 0,
          event_resources_incomplete: 0, team_resources_incomplete: 0, read_errors: 0,
        };
        for (const item of directory.events) {
          if (!isValidEventLifecycleInput(item)) {
            counts.events_invalid_dates += 1;
            continue;
          }
          const lifecycle = lifecycleFor(item, now).lifecycle;
          if (lifecycle === "completed" || lifecycle === "expired") counts.events_happened += 1;
          else if (lifecycle === "active") counts.events_active += 1;
          else if (lifecycle === "upcoming") counts.events_upcoming += 1;
        }
        const allItemsKey = itemsPrefix + "all.json";
        await createDiscoveryServiceClient(this.env).put(allItemsKey, JSON.stringify(items), {
          httpMetadata: { contentType: "application/json" },
        });
        const record: CoverageAuditRecord = {
          year, workflow_id: workflowId, status: "running", started_at: startedAt, updated_at: now,
          cursor: 0, total: items.length, event_discovery_updated_at: directory.eventUpdatedAt,
          team_discovery_updated_at: directory.teamUpdatedAt, items_prefix: itemsPrefix, counts, error: null,
        };
        await createDiscoveryServiceClient(this.env).put(auditKey, JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
        });
        return { total: items.length, chunkCount: Math.ceil(items.length / 100), counts, itemsPrefix, record };
      });

      for (let firstChunk = 0; firstChunk < prepared.chunkCount; firstChunk += 10) {
        const endChunk = Math.min(prepared.chunkCount, firstChunk + 10);
        await step.do(`write-coverage-audit-items-${firstChunk}`, async () => {
          const allItems = await readJson<CoverageAuditItem[]>(createDiscoveryServiceClient(this.env), prepared.itemsPrefix + "all.json");
          if (!allItems || allItems.length !== prepared.total) throw new Error("Coverage audit item manifest is missing or incomplete");
          for (let chunk = firstChunk; chunk < endChunk; chunk += 1) {
            await createDiscoveryServiceClient(this.env).put(
              prepared.itemsPrefix + `${chunk}.json`,
              JSON.stringify(allItems.slice(chunk * 100, (chunk + 1) * 100)),
              { httpMetadata: { contentType: "application/json" } },
            );
          }
          return { chunks_written: endChunk - firstChunk };
        });
      }

      let cursor = 0;
      let counts = prepared.counts;
      while (cursor < prepared.total) {
        const batchResult = await step.do(`audit-runtime-batch-${cursor}`, {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        }, async () => {
          const chunkIndex = Math.floor(cursor / 100);
          const chunk = await readJson<CoverageAuditItem[]>(createDiscoveryServiceClient(this.env), prepared.itemsPrefix + `${chunkIndex}.json`);
          if (!chunk) throw new Error(`Coverage audit item chunk ${chunkIndex} is missing`);
          const batch = chunk.slice(cursor % 100, cursor % 100 + 5);
          const nextCounts = { ...counts };
          for (const item of batch) {
            const missing = () => {
              if (item.kind === "event") {
                nextCounts.event_runtime_missing += 1;
                nextCounts.event_state_missing += 1;
                nextCounts.event_analytics_missing += 1;
                nextCounts.event_cohort_missing += 1;
              } else {
                nextCounts.team_runtime_missing += 1;
                nextCounts.team_snapshot_missing += 1;
              }
            };
            if (!item.registered) { missing(); continue; }
            try {
              const response = await dispatchRuntime(
                this.env, item.kind, item.key, "state", {}, year,
              );
              if (response.status === 401 || response.status === 403 || response.status === 503) {
                throw new Error(`Runtime state boundary returned HTTP ${response.status}`);
              }
              if (response.status === 429 || response.status >= 500) {
                nextCounts.read_errors += 1;
                missing();
                continue;
              }
              if (!response.ok) { missing(); continue; }
              const state = await response.json() as {
                endpoints?: Record<string, { lastFetchedAt?: number | null; last_fetched_at?: number | null; lastWebhookAt?: number | null; last_webhook_at?: number | null; expiresAt?: number | null; expires_at?: number | null; status?: string }> |
                  Array<{ lastFetchedAt?: number | null; last_fetched_at?: number | null; lastWebhookAt?: number | null; last_webhook_at?: number | null; expiresAt?: number | null; expires_at?: number | null; status?: string }>;
                analytics?: { status?: string; cohort_status?: string | null };
                event_state?: { status?: string; generated_at?: number | null; source_revision?: number | null };
              };
              const endpointStates = Array.isArray(state.endpoints) ? state.endpoints : Object.values(state.endpoints ?? {});
              const acquiredResources = endpointStates.filter((resource) =>
                resource.lastFetchedAt != null || resource.last_fetched_at != null ||
                resource.lastWebhookAt != null || resource.last_webhook_at != null).length;
              const incompleteResources = endpointStates.filter((resource) =>
                resource.status === "failed" || resource.status === "unavailable" || resource.status === "stale" ||
                ((resource.expiresAt ?? resource.expires_at) != null &&
                  (resource.expiresAt ?? resource.expires_at)! < Date.now())).length;
              if (item.kind === "event") {
                if (acquiredResources < 13 || incompleteResources > 0) nextCounts.event_resources_incomplete += 1;
                const eventStateStatus = state.event_state?.status ?? "missing";
                if (eventStateStatus === "complete") nextCounts.event_state_complete += 1;
                else if (eventStateStatus === "partial") nextCounts.event_state_partial += 1;
                else if (eventStateStatus === "stale") nextCounts.event_state_stale += 1;
                else if (eventStateStatus === "failed") nextCounts.event_state_failed += 1;
                else nextCounts.event_state_missing += 1;
                const analyticsStatus = state.analytics?.status ?? "missing";
                if (analyticsStatus === "succeeded") nextCounts.event_analytics_succeeded += 1;
                else if (analyticsStatus === "partial") nextCounts.event_analytics_partial += 1;
                else if (analyticsStatus === "stale") nextCounts.event_analytics_stale += 1;
                else if (analyticsStatus === "waiting-for-cohort") nextCounts.event_analytics_waiting += 1;
                else if (analyticsStatus === "failed") nextCounts.event_analytics_failed += 1;
                else nextCounts.event_analytics_missing += 1;
                const cohortStatus = state.analytics?.cohort_status ??
                  (analyticsStatus === "waiting-for-cohort" ? "discovering" : "missing");
                if (cohortStatus === "complete") nextCounts.event_cohort_complete += 1;
                else if (cohortStatus === "partial") nextCounts.event_cohort_partial += 1;
                else if (cohortStatus === "discovering") nextCounts.event_cohort_discovering += 1;
                else nextCounts.event_cohort_missing += 1;
              } else {
                if (acquiredResources >= 7 && incompleteResources === 0) nextCounts.team_snapshot_complete += 1;
                else if (acquiredResources > 0) nextCounts.team_snapshot_partial += 1;
                else nextCounts.team_snapshot_failed += 1;
                if (acquiredResources < 7 || incompleteResources > 0) nextCounts.team_resources_incomplete += 1;
              }
            } catch (error) {
              if (String(error).includes("Runtime state boundary returned HTTP")) throw error;
              nextCounts.read_errors += 1;
              missing();
            }
          }
          const nextCursor = cursor + batch.length;
          const record: CoverageAuditRecord = {
            ...prepared.record, cursor: nextCursor, counts: nextCounts,
            status: "running", updated_at: Date.now(),
          };
          await createDiscoveryServiceClient(this.env).put(auditKey, JSON.stringify(record), {
            httpMetadata: { contentType: "application/json" },
          });
          return { cursor: nextCursor, counts: nextCounts };
        });
        cursor = batchResult.cursor;
        counts = batchResult.counts;
      }

      const completed = await step.do("complete-coverage-audit", async () => {
        const current = await readPublishedSeason(createDiscoveryServiceClient(this.env), year);
        const stale = !current ||
          current.eventUpdatedAt !== prepared.record.event_discovery_updated_at ||
          current.teamUpdatedAt !== prepared.record.team_discovery_updated_at;
        const record: CoverageAuditRecord = {
          ...prepared.record, cursor, counts, status: stale ? "stale" : "completed",
          updated_at: Date.now(), error: null,
        };
        await createDiscoveryServiceClient(this.env).put(auditKey, JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
        });
        return record;
      });
      return { ...completed };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await step.do("record-coverage-audit-failure", async () => {
        const current = await readJson<CoverageAuditRecord>(createDiscoveryServiceClient(this.env), auditKey);
        if (current) await createDiscoveryServiceClient(this.env).put(auditKey, JSON.stringify({
          ...current, status: "failed", error: detail.slice(0, 500), updated_at: Date.now(),
        }), { httpMetadata: { contentType: "application/json" } });
        return { status: "failed", error: detail };
      });
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: JobsEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ service: "runtime-workflows", status: "ok" });
    if (url.pathname === "/internal/admin/runtime-job" && (request.method === "GET" || request.method === "POST")) {
      if (!env.RUNTIME_ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const operationValues = ["team-seed", "event-team-seed", "season-ingest"] as const;
      const body: unknown = request.method === "POST" ? await request.json().catch(() => null) : null;
      const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const operation = String(request.method === "GET" ? url.searchParams.get("operation") : value.operation) as RuntimeAdminParameters["operation"];
      if (!operationValues.includes(operation as typeof operationValues[number])) return Response.json({ error: "Invalid runtime job operation" }, { status: 400 });
      const year = Number(request.method === "GET" ? url.searchParams.get("year") : value.year);
      if (!Number.isInteger(year) || year < 1992 || year > 2200) return Response.json({ error: "Invalid season year" }, { status: 400 });
      const teamKey = String(request.method === "GET" ? url.searchParams.get("team_key") ?? "" : value.team_key ?? "");
      const eventKey = String(request.method === "GET" ? url.searchParams.get("event_key") ?? "" : value.event_key ?? "");
      if (operation === "team-seed" && !/^frc\d+$/.test(teamKey)) return Response.json({ error: "A valid team_key is required" }, { status: 400 });
      if (operation === "event-team-seed" && (!/^[a-zA-Z0-9_-]+$/.test(eventKey) || !eventKey.startsWith(String(year)))) return Response.json({ error: "A valid event_key and matching year are required" }, { status: 400 });
      const subject = operation === "team-seed" ? teamKey : operation === "event-team-seed" ? eventKey : String(year);
      const indexKey = `admin/runtime-job-index/${operation}/${subject}.json`;
      let pointer = await readJson<{ workflow_id: string }>(createDiscoveryServiceClient(env), indexKey);
      if (request.method === "GET") {
        if (!pointer) return Response.json({ year, operation, status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
        const record = await readJson<Record<string, unknown>>(createDiscoveryServiceClient(env), `admin/runtime-jobs/${pointer.workflow_id}.json`);
        if (!record) return Response.json({ year, operation, status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
        let workflowStatus: string | null = null;
        try { workflowStatus = (await (await env.RUNTIME_ADMIN.get(pointer.workflow_id)).status()).status; } catch { workflowStatus = null; }
        const mappedStatus = workflowStatus === "paused" ? "paused"
          : workflowStatus === "terminated" ? "cancelled"
          : workflowStatus === "errored" ? "failed"
          : workflowStatus === "complete" ? record.status : record.status;
        const history = await createDiscoveryServiceClient(env).list({ prefix: `admin/runtime-job-history/${operation}/${subject}/`, limit: 1000 });
        return Response.json({ ...record, status: mappedStatus, workflow_status: workflowStatus, history_count: history.objects.length }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      let action = String(value.action ?? "start");
      let retryingPartial = false;
      if (!["start", "pause", "resume", "cancel", "preview"].includes(action)) return Response.json({ error: "Invalid runtime job action" }, { status: 400 });
      if (action === "resume" && pointer) {
        const prior = await readJson<Record<string, unknown>>(createDiscoveryServiceClient(env), `admin/runtime-jobs/${pointer.workflow_id}.json`);
        const priorStatus = await env.RUNTIME_ADMIN.get(pointer.workflow_id).then((instance) => instance.status()).catch(() => null);
        if (prior?.status === "completed_with_errors" && priorStatus?.status === "complete") {
          action = "start";
          retryingPartial = true;
        }
      }
      if (action === "preview") {
        const events = await readJson<DiscoveryDocument>(createDiscoveryServiceClient(env), `discovery/events/${year}.json`);
        const teams = await readJson<string[]>(createDiscoveryServiceClient(env), `registry/teams/${year}.json`);
        return Response.json({ year, ready: Boolean(events?.events?.length && teams?.length),
          events: events?.events?.length ?? 0, teams: teams?.length ?? 0,
          planned_runtime_initializations: (events?.events?.length ?? 0) + (teams?.length ?? 0),
          requires_explicit_confirmation: true });
      }
      if (action !== "start") {
        if (!pointer) return Response.json({ error: "No runtime job exists" }, { status: 404 });
        const instance = await env.RUNTIME_ADMIN.get(pointer.workflow_id);
        const status = await instance.status();
        if (action === "pause") {
          if (!["queued", "running", "waiting", "waitingForPause"].includes(status.status)) return Response.json({ error: "Workflow is not active" }, { status: 409 });
          await instance.pause();
        } else if (action === "resume") {
          if (status.status !== "paused") return Response.json({ error: "Workflow is not paused" }, { status: 409 });
          await instance.resume();
        } else {
          if (["complete", "errored", "terminated"].includes(status.status)) return Response.json({ error: "Workflow is already terminal" }, { status: 409 });
          await instance.terminate();
        }
        return Response.json({ workflow_id: pointer.workflow_id, status: action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled" }, { status: 202 });
      }
      if (operation === "season-ingest" && value.confirm !== true && !retryingPartial) {
        return Response.json({ error: "Explicit confirmation is required" }, { status: 400 });
      }
      if (pointer) {
        try {
          const status = await (await env.RUNTIME_ADMIN.get(pointer.workflow_id)).status();
          if (["queued", "running", "waiting", "waitingForPause", "paused"].includes(status.status)) return Response.json({ error: "A runtime job is already active", workflow_id: pointer.workflow_id }, { status: 409 });
        } catch { /* Previous Workflow instance is no longer available. */ }
      }
      if (pointer) {
        const previous = await readJson<Record<string, unknown>>(createDiscoveryServiceClient(env), `admin/runtime-jobs/${pointer.workflow_id}.json`);
        if (previous) await createDiscoveryServiceClient(env).put(
          `admin/runtime-job-history/${operation}/${subject}/${pointer.workflow_id}.json`,
          JSON.stringify(previous), { httpMetadata: { contentType: "application/json" } },
        );
      }
      const requestedAt = Date.now();
      const workflowId = `runtime-admin-${operation}-${subject}-${requestedAt}`;
      const params: RuntimeAdminParameters = { operation, workflowId, year, requestedAt,
        ...(operation === "team-seed" ? { teamKey } : {}),
        ...(operation === "event-team-seed" ? { eventKey } : {}) };
      const initial = {
        workflow_id: workflowId, operation, year, status: "running", phase: "queued", stage: "queued",
        processed: 0, total: 0, started_at: requestedAt, updated_at: requestedAt, counts: {}, errors: [],
        ...(operation === "team-seed" ? { team_key: teamKey, scheduled_events: 0 } : {}),
        ...(operation === "event-team-seed" ? {
          event_key: eventKey, team_keys: [], cursor: 0, active_team_key: null,
          seeded_teams: 0, failed_teams: 0, historical_events_scheduled: 0,
        } : {}),
      };
      await createDiscoveryServiceClient(env).put(`admin/runtime-jobs/${workflowId}.json`, JSON.stringify(initial), { httpMetadata: { contentType: "application/json" } });
      await createDiscoveryServiceClient(env).put(indexKey, JSON.stringify({ workflow_id: workflowId }), { httpMetadata: { contentType: "application/json" } });
      try { await env.RUNTIME_ADMIN.create({ id: workflowId, params }); }
      catch (error) {
        const failed = { ...initial, status: "failed", phase: "failed", errors: [{ key: subject, detail: error instanceof Error ? error.message : String(error), at: Date.now() }] };
        await createDiscoveryServiceClient(env).put(`admin/runtime-jobs/${workflowId}.json`, JSON.stringify(failed), { httpMetadata: { contentType: "application/json" } });
        return Response.json(failed, { status: 409 });
      }
      return Response.json(initial, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/internal/admin/coverage-audit" && request.method === "GET") {
      if (!env.RUNTIME_ADMIN_TOKEN ||
          request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const year = Number(url.searchParams.get("year"));
      if (!Number.isInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid audit year" }, { status: 400 });
      }
      const record = await readJson<CoverageAuditRecord>(createDiscoveryServiceClient(env), `admin/coverage-audits/${year}.json`);
      const discoveryReady = (await readPublishedSeason(createDiscoveryServiceClient(env), year)) !== null;
      if (!record) return Response.json({ year, status: "not_started", discovery_ready: discoveryReady }, {
        headers: { "Cache-Control": "no-store" },
      });
      let workflowStatus: string | null = null;
      try {
        const instance = await env.COVERAGE_AUDIT.get(record.workflow_id);
        workflowStatus = (await instance.status()).status;
      } catch { workflowStatus = null; }
      const status = workflowStatus === "paused" ? "paused"
        : workflowStatus === "errored" ? "failed"
        : workflowStatus === "terminated" ? "cancelled"
        : workflowStatus === "complete" ? record.status
        : record.status;
      return Response.json({
        ...record, status, workflow_status: workflowStatus, discovery_ready: discoveryReady,
        processed: record.cursor, remaining: Math.max(0, record.total - record.cursor),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/internal/admin/coverage-audit" && request.method === "POST") {
      if (!env.RUNTIME_ADMIN_TOKEN ||
          request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "Invalid coverage audit request" }, { status: 400 });
      }
      const value = body as Record<string, unknown>;
      const year = Number(value.year);
      const action = value.action;
      if (!Number.isInteger(year) || year < 1992 || year > 2200 ||
          !["start", "continue", "pause"].includes(String(action))) {
        return Response.json({ error: "Expected a valid year and start, continue, or pause action" }, { status: 400 });
      }
      const key = `admin/coverage-audits/${year}.json`;
      let current = await readJson<CoverageAuditRecord>(createDiscoveryServiceClient(env), key);
      if (action === "start") {
        const directory = await readPublishedSeason(createDiscoveryServiceClient(env), year);
        if (!directory) return Response.json({
          error: "Run complete event and paginated team discovery before starting the full coverage audit.",
        }, { status: 409 });
        if (current?.status === "running") {
          try {
            const existing = await env.COVERAGE_AUDIT.get(current.workflow_id);
            const status = await existing.status();
            if (["queued", "running", "waiting", "waitingForPause", "paused"].includes(status.status)) {
              return Response.json({ ...current, workflow_status: status.status }, {
                status: 202, headers: { "Cache-Control": "no-store" },
              });
            }
          } catch { /* Missing or terminal instance can be replaced by a new audit. */ }
        }
        if (current) {
          await createDiscoveryServiceClient(env).put(
            `admin/coverage-audit-history/${year}/${current.workflow_id}.json`,
            JSON.stringify(current),
            { httpMetadata: { contentType: "application/json" } },
          );
        }
        const startedAt = Date.now();
        const workflowId = `coverage-audit-${year}-${startedAt}`;
        const zeroCounts: CoverageAuditCounts = {
          events_total: directory.events.length, events_happened: 0, events_active: 0, events_upcoming: 0, events_invalid_dates: 0,
          teams_total: directory.teamKeys.length, team_pages: directory.teamPageCount,
          event_runtime_missing: 0, team_runtime_missing: 0,
          event_state_complete: 0, event_state_partial: 0, event_state_stale: 0, event_state_missing: 0, event_state_failed: 0,
          event_analytics_succeeded: 0, event_analytics_partial: 0, event_analytics_stale: 0, event_analytics_waiting: 0, event_analytics_missing: 0, event_analytics_failed: 0,
          event_cohort_complete: 0, event_cohort_partial: 0, event_cohort_discovering: 0, event_cohort_missing: 0,
          team_snapshot_complete: 0, team_snapshot_partial: 0, team_snapshot_missing: 0, team_snapshot_failed: 0,
          event_resources_incomplete: 0, team_resources_incomplete: 0, read_errors: 0,
        };
        current = {
          year, workflow_id: workflowId, status: "running", started_at: startedAt, updated_at: startedAt,
          cursor: 0, total: directory.events.length + directory.teamKeys.length,
          event_discovery_updated_at: directory.eventUpdatedAt, team_discovery_updated_at: directory.teamUpdatedAt,
          items_prefix: `admin/coverage-audit-items/${year}/${workflowId}/`, counts: zeroCounts, error: null,
        };
        await createDiscoveryServiceClient(env).put(key, JSON.stringify(current), {
          httpMetadata: { contentType: "application/json" },
        });
        try {
          await env.COVERAGE_AUDIT.create({
            id: workflowId, params: { year, workflowId, startedAt },
          });
        } catch (error) {
          const failed = { ...current, status: "failed" as const,
            error: error instanceof Error ? error.message : String(error), updated_at: Date.now() };
          await createDiscoveryServiceClient(env).put(key, JSON.stringify(failed), {
            httpMetadata: { contentType: "application/json" },
          });
          return Response.json(failed, { status: 409 });
        }
        return Response.json(current, { status: 202, headers: { "Cache-Control": "no-store" } });
      }
      if (!current) return Response.json({ error: "No coverage audit exists for this season" }, { status: 404 });
      const instance = await env.COVERAGE_AUDIT.get(current.workflow_id).catch(() => null);
      if (!instance) return Response.json({ error: "Coverage audit Workflow instance is unavailable" }, { status: 404 });
      const status = await instance.status();
      if (action === "pause") {
        if (!["queued", "running", "waiting", "waitingForPause"].includes(status.status)) {
          return Response.json({ error: "Only an active coverage audit can be paused" }, { status: 409 });
        }
        await instance.pause();
      } else {
        if (status.status !== "paused") return Response.json({ error: "Only a paused coverage audit can be resumed" }, { status: 409 });
        await instance.resume();
      }
      return Response.json({ ...current, status: action === "pause" ? "paused" : "running" }, {
        status: 202, headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/internal/admin/discovery-job" && request.method === "GET") {
      if (!env.RUNTIME_ADMIN_TOKEN ||
          request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const year = Number(url.searchParams.get("year"));
      if (!Number.isInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid discovery year" }, { status: 400 });
      }
      const job = await readJson<AdminDiscoveryJobRecord>(createDiscoveryServiceClient(env), `admin/discovery-jobs/${year}.json`);
      if (!job) return Response.json({ year, status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
      let workflowStatus: string | null = null;
      try {
        const instance = await env.SEASON_DISCOVERY.get(job.workflow_id);
        workflowStatus = (await instance.status()).status;
      } catch { workflowStatus = null; }
      const status = workflowStatus === "paused" ? "paused"
        : workflowStatus === "errored" ? "failed"
        : workflowStatus === "terminated" ? "cancelled"
        : job.status;
      return Response.json({ ...job, status, workflow_status: workflowStatus }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/internal/admin/discover-year" && request.method === "POST") {
      if (!env.RUNTIME_ADMIN_TOKEN ||
          request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const body: unknown = await request.json().catch(() => null);
      const year = body && typeof body === "object" && !Array.isArray(body)
        ? Number((body as Record<string, unknown>).year) : NaN;
      if (!Number.isInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid discovery year" }, { status: 400 });
      }
      const key = `admin/discovery-jobs/${year}.json`;
      const current = await readJson<AdminDiscoveryJobRecord>(createDiscoveryServiceClient(env), key);
      if (current?.status === "running") {
        try {
          const instance = await env.SEASON_DISCOVERY.get(current.workflow_id);
          const status = await instance.status();
          if (["queued", "running", "waiting", "waitingForPause", "paused"].includes(status.status)) {
            return Response.json({ ...current, workflow_status: status.status }, {
              status: 202, headers: { "Cache-Control": "no-store" },
            });
          }
        } catch { /* A terminal or missing instance can be replaced by a new run. */ }
      }
      const requestedAt = Date.now();
      const workflowId = `admin-discovery-${year}-${requestedAt}`;
      const job: AdminDiscoveryJobRecord = {
        year, mode: "year", workflow_id: workflowId, status: "running", stage: "queued",
        events: 0, teams: 0, team_pages: 0, steps: 0, error: null,
        started_at: requestedAt, updated_at: requestedAt,
      };
      await createDiscoveryServiceClient(env).put(key, JSON.stringify(job), {
        httpMetadata: { contentType: "application/json" },
      });
      try {
        await env.SEASON_DISCOVERY.create({
          id: workflowId,
          params: { operation: "discover-season", year, requestedAt, jobId: workflowId },
        });
      } catch (error) {
        const failed = { ...job, status: "failed" as const, stage: "failed",
          error: error instanceof Error ? error.message : String(error), updated_at: Date.now() };
        await createDiscoveryServiceClient(env).put(key, JSON.stringify(failed), {
          httpMetadata: { contentType: "application/json" },
        });
        return Response.json(failed, { status: 409 });
      }
      return Response.json(job, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/internal/admin/workflow-runs" && request.method === "GET") {
      if (!env.RUNTIME_ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const type = url.searchParams.get("type");
      if (type !== "event-readiness" && type !== "team-readiness") {
        return Response.json({ error: "A valid workflow type is required" }, { status: 400 });
      }
      const store = createDiscoveryServiceClient(env);
      const workflowId = url.searchParams.get("id");
      if (workflowId) {
        if (!/^[a-zA-Z0-9_-]{1,160}$/.test(workflowId)) return Response.json({ error: "Invalid workflow ID" }, { status: 400 });
        const prefix = `admin/workflow-runs/${type}/${workflowId}`;
        const recordObject = await store.get(`${prefix}/record.json`);
        if (!recordObject) return Response.json({ error: "Workflow run not found" }, { status: 404 });
        const record = await recordObject.json<Record<string, unknown>>();
        const workflowBinding = type === "event-readiness" ? env.EVENT_SEASON_READINESS : env.TEAM_SEASON_READINESS;
        let workflowStatus: string | null = null;
        let workflowError: string | null = null;
        try {
          const status = await workflowBinding.get(workflowId).then((instance) => instance.status());
          workflowStatus = status.status;
          if (status.status === "errored") workflowError = JSON.stringify(status).slice(0, 1000);
        } catch { workflowStatus = null; }
        let resolvedRecord = record;
        if (workflowStatus === "errored" && ["running", "queued"].includes(String(record.status))) {
          resolvedRecord = { ...record, status: "failed", updated_at: Date.now(), completed_at: Date.now(), error: workflowError ?? "Workflow execution failed" };
          await store.put(`${prefix}/record.json`, JSON.stringify(resolvedRecord), { httpMetadata: { contentType: "application/json" } });
        } else if (workflowStatus === "terminated" && ["running", "queued"].includes(String(record.status))) {
          resolvedRecord = { ...record, status: "cancelled", updated_at: Date.now(), completed_at: Date.now() };
          await store.put(`${prefix}/record.json`, JSON.stringify(resolvedRecord), { httpMetadata: { contentType: "application/json" } });
        }
        const summaryObject = await store.get(`${prefix}/summary.json`);
        const summary = summaryObject ? await summaryObject.json<Record<string, unknown>>() : null;
        const results: unknown[] = [];
        const chunkCount = Number(resolvedRecord.result_chunks ?? 0);
        for (let chunk = 0; chunk < chunkCount; chunk += 1) {
          const object = await store.get(`${prefix}/results/${String(chunk).padStart(4, "0")}.json`);
          if (!object) continue;
          const value = await object.json<{ results?: unknown[] }>();
          if (Array.isArray(value.results)) results.push(...value.results);
        }
        return Response.json({ ...resolvedRecord, workflow_status: workflowStatus, summary, results }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
      const page = await store.list({ prefix: `admin/workflow-runs/index/${type}/`, limit: 1000 });
      const entries = page.objects.slice(-limit).reverse();
      const runs = [];
      for (const entry of entries) {
        const object = await store.get(entry.key);
        if (!object) continue;
        const indexRecord = await object.json<Record<string, unknown>>();
        const id = typeof indexRecord.workflow_id === "string" ? indexRecord.workflow_id : "";
        const recordObject = id ? await store.get(`admin/workflow-runs/${type}/${id}/record.json`) : null;
        let record = recordObject ? await recordObject.json<Record<string, unknown>>() : {};
        if (id && ["running", "queued"].includes(String(record.status))) {
          try {
            const binding = type === "event-readiness" ? env.EVENT_SEASON_READINESS : env.TEAM_SEASON_READINESS;
            const workflowStatus = (await binding.get(id).then((instance) => instance.status())).status;
            if (workflowStatus === "errored" || workflowStatus === "terminated") {
              record = { ...record, status: workflowStatus === "errored" ? "failed" : "cancelled",
                updated_at: Date.now(), completed_at: Date.now(),
                ...(workflowStatus === "errored" ? { error: "Cloudflare Workflow execution failed; inspect the Workflow instance for details." } : {}) };
              await store.put(`admin/workflow-runs/${type}/${id}/record.json`, JSON.stringify(record), {
                httpMetadata: { contentType: "application/json" },
              });
            }
            record = { ...record, workflow_status: workflowStatus };
          } catch { /* Retain the durable run record if the Workflow status API is temporarily unavailable. */ }
        }
        runs.push({ ...indexRecord, ...record });
      }
      return Response.json({ type, runs, total: page.objects.length }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/internal/admin/events-this-week/refresh" &&
        (request.method === "GET" || request.method === "POST")) {
      if (!env.RUNTIME_ADMIN_TOKEN ||
          request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const workflow = env.WEEKLY_EVENT_PROJECTION;
      if (!workflow) return Response.json({ error: "Weekly event projection Workflow is unavailable" }, { status: 503 });
      if (request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id || !/^events-this-week-manual-[0-9]{10,16}$/.test(id)) {
          return Response.json({ error: "A valid workflow ID is required" }, { status: 400 });
        }
        try {
          const status = await workflow.get(id).then((instance) => instance.status());
          return Response.json({ workflow_id: id, workflow_status: status.status }, {
            headers: { "Cache-Control": "no-store" },
          });
        } catch {
          return Response.json({ error: "Weekly event projection Workflow was not found" }, { status: 404 });
        }
      }
      const requestedAt = Date.now();
      const id = "events-this-week-manual-" + requestedAt;
      try {
        await workflow.create({ id, params: { requestedAt, reason: "manual" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Unable to start weekly event projection" }, { status: 409 });
      }
      return Response.json({ workflow_id: id, scheduled_at: requestedAt, status: "queued" }, {
        status: 202, headers: { "Cache-Control": "no-store" },
      });
    }

    if ((url.pathname === "/internal/admin/event-season-readiness" ||
         url.pathname === "/internal/admin/team-season-readiness") && request.method === "POST") {
      if (!env.RUNTIME_ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const body = await request.json().catch(() => null) as { year?: unknown } | null;
      const year = body?.year;
      if (!Number.isInteger(year) || Number(year) < 1992 || Number(year) > 2200) return Response.json({ error: "A four-digit season year is required" }, { status: 400 });
      const kind = url.pathname.includes("event-") ? "event" : "team";
      const scheduledAt = Date.now();
      const id = kind + "-season-readiness-" + Number(year) + "-" + scheduledAt;
      const workflow = kind === "event" ? env.EVENT_SEASON_READINESS : env.TEAM_SEASON_READINESS;
      try { await workflow.create({ id, params: { year: Number(year), requestedAt: scheduledAt } }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to start season readiness" }, { status: 409 }); }
      return Response.json({ workflow_id: id, workflow_type: kind + "-readiness", year: Number(year), scheduled_at: scheduledAt, status: "queued" }, { status: 202 });
    }

    if (url.pathname === "/internal/admin/season-status-resolver" && request.method === "POST") {
      if (!env.RUNTIME_ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const scheduledAt = Date.now();
      const id = "season-status-resolver-" + scheduledAt;
      try { await env.SEASON_STATUS_RESOLVER.create({ id, params: { requestedAt: scheduledAt } }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to start canonical season resolver" }, { status: 409 }); }
      return Response.json({ workflow_id: id, scheduled_at: scheduledAt, status: "queued" }, { status: 202 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },

};
