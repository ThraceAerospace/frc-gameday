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
  operation?: "discover-season" | "register-event-batch" | "discover-team-directory" | "register-team-batch";
  year?: number;
  requestedAt?: number;
  jobId?: string;
  cursor?: number;
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}

async function readJson<T>(bucket: DiscoveryServiceClient, key: string): Promise<T | null> {
  return bucket.get<T>(key);
}

async function listRuntimeRegistry(bucket: DiscoveryServiceClient, kind: "event" | "team"): Promise<string[]> {
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const runtimeKey = key.slice(prefix.length).replace(/\.json$/, "");
      if (runtimeKey) keys.push(runtimeKey);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
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

/** Season discovery is deliberately phased: events first, then independently resumable teams. */
export class SeasonDiscoveryWorkflowBase extends WorkflowEntrypoint<JobsEnvironment, WorkflowParameters> {
  async run(event: WorkflowEvent<WorkflowParameters>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const payload = event.payload ?? {};
    const year = payload.year;
    const jobId = payload.jobId;
    if (!Number.isInteger(year) || year! < 1992 || year! > 2200 || !jobId) {
      throw new Error("Season discovery requires a valid year and job ID");
    }
    const season = year!;
    const store = createDiscoveryServiceClient(this.env);
    const jobKey = `admin/discovery-jobs/${season}.json`;
    const job = await readJson<AdminDiscoveryJobRecord>(store, jobKey);
    const requestedAt = payload.requestedAt ?? job?.started_at ?? Date.now();
    const child = async (id: string, operation: WorkflowParameters["operation"], cursor = 0) => {
      await step.do("schedule-" + id, async () => {
        await this.env.SEASON_DISCOVERY.create({
          id,
          params: { operation, year: season, requestedAt, jobId, cursor },
        });
        return { id, operation };
      });
    };
    const update = async (name: string, patch: Partial<AdminDiscoveryJobRecord>) => step.do(name, async () => {
      const current = await readJson<AdminDiscoveryJobRecord>(store, jobKey);
      const next: AdminDiscoveryJobRecord = {
        mode: "year", status: "running", stage: "starting",
        events: 0, teams: 0, team_pages: 0, expected_team_pages: 0, failed_team_pages: [],
        warnings: [], team_directory_complete: false, steps: 0, error: null,
        started_at: requestedAt,
        ...(current ?? {}), ...patch, workflow_id: jobId, year: season, updated_at: Date.now(),
      };
      await store.put(jobKey, JSON.stringify(next));
      return next;
    });

    try {
      if (payload.operation === "discover-season") {
        const raw = await step.do("read-canonical-season-status", async () =>
          this.env.KV_BINDING?.get("system/canonical-season.json"));
        if (!raw) throw new Error("Canonical season status is missing; run the season status resolver first");
        const canonical = JSON.parse(raw) as { year?: unknown; maxTeamPage?: unknown };
        if (canonical.year !== season || !Number.isInteger(canonical.maxTeamPage) || Number(canonical.maxTeamPage) < 0) {
          throw new Error("Canonical season status is invalid or does not match the requested year");
        }
        await update("record-event-discovery-started", { stage: "discovering_events" });
        const generation = await step.do("allocate-season-directory-generation", async () => Date.now());
        const eventChunkSize = 25;
        const priorEvents = await readJson<DiscoveryDocument>(store, `discovery/events/${season}.json`);
        const directory = priorEvents?.year === season && Array.isArray(priorEvents.events)
          ? { count: priorEvents.events.length, generation, chunkCount: 0, needsChunking: false }
          : await step.do("discover-season-events", {
            retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
          }, async () => {
            const response = await store.catalog("discover-event-directory", { year: season, generation, chunkSize: eventChunkSize });
            if (!response.ok) throw new Error("Event directory acquisition returned HTTP " + response.status);
            return response.json() as Promise<{ count: number; generation: number; chunkCount: number; needsChunking: boolean }>;
          });
        if (directory.needsChunking) {
          for (let first = 0; first < directory.chunkCount; first += 10) {
            const last = Math.min(directory.chunkCount, first + 10);
            await step.do("publish-event-chunks-" + first, async () => {
              const response = await store.catalog("write-event-chunks", {
                year: season, generation: directory.generation, firstChunk: first, endChunk: last, chunkSize: eventChunkSize,
              });
              if (!response.ok) throw new Error("Event chunk publication returned HTTP " + response.status);
              return response.json();
            });
          }
          await step.do("publish-event-directory", async () => {
            const response = await store.catalog("publish-event-directory", { year: season, generation: directory.generation });
            if (!response.ok) throw new Error("Event directory publication returned HTTP " + response.status);
            return response.json();
          });
        }
        await update("record-events-published", { stage: "registering_events", events: directory.count });
        await child(jobId + "-event-registration-0000", "register-event-batch");
        return { year: season, stage: "registering_events", events: directory.count, status: "running" };
      }

      if (payload.operation === "register-event-batch" || payload.operation === "register-team-batch") {
        const kind = payload.operation === "register-event-batch" ? "event" : "team";
        const keys = kind === "event"
          ? (await readJson<DiscoveryDocument>(store, `discovery/events/${season}.json`))?.events.map(item => item.key) ?? []
          : await readJson<string[]>(store, `registry/teams/${season}.json`) ?? [];
        const valid = [...new Set(keys)].filter(key => kind === "event" ? /^[a-zA-Z0-9_-]+$/.test(key) : /^frc[0-9]+$/.test(key));
        const cursor = Math.max(0, Math.floor(payload.cursor ?? 0));
        const batchSize = 10;
        const batch = valid.slice(cursor, cursor + batchSize);
        const namespace = kind === "event" ? this.env.EVENT_RUNTIME : this.env.TEAM_RUNTIME;
        if (!namespace) throw new Error(kind + " runtime namespace is unavailable");
        const markerPrefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
        let initialized = 0;
        for (const key of batch) {
          await step.do("register-" + kind + "-" + key, async () => {
            if (await store.get(markerPrefix + key + ".json") !== null) return { alreadyRegistered: true };
            const identityHeader = kind === "event" ? "X-FieldView-Event-Key" : "X-FieldView-Team-Key";
            const response = await namespace.get(namespace.idFromName(key)).fetch(new Request("https://" + kind + "-runtime/register", {
              method: "POST",
              headers: { Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN, [identityHeader]: key },
            }));
            if (!response.ok) throw new Error(kind + " runtime registration failed for " + key + " with HTTP " + response.status);
            await store.put(markerPrefix + key + ".json", "{}");
            return { registered: true };
          });
          initialized++;
        }
        const next = cursor + batch.length;
        if (next < valid.length) {
          const nextId = jobId + "-" + kind + "-registration-" + String(next).padStart(4, "0");
          await child(nextId, payload.operation, next);
          await update("record-" + kind + "-registration-progress-" + cursor, {
            stage: kind === "event" ? "registering_events" : "registering_teams",
            ...(kind === "event" ? { events: valid.length } : { teams: valid.length }),
          });
          return { kind, registered: next, total: valid.length, next: nextId };
        }
        if (kind === "event") {
          await update("record-event-registration-complete", { stage: "discovering_teams" });
          await child(jobId + "-team-directory", "discover-team-directory");
          return { kind, registered: valid.length, next: "discover-team-directory" };
        }
        await update("record-team-registration-complete", {
          stage: "complete", status: "completed", teams: valid.length, team_directory_complete: true,
          error: null,
        });
        return { kind, registered: valid.length, status: "completed" };
      }

      if (payload.operation === "discover-team-directory") {
        const raw = await step.do("read-canonical-team-page-bound", async () =>
          this.env.KV_BINDING?.get("system/canonical-season.json"));
        if (!raw) throw new Error("Canonical season status is missing");
        const canonical = JSON.parse(raw) as { year?: unknown; maxTeamPage?: unknown };
        if (canonical.year !== season || !Number.isInteger(canonical.maxTeamPage) || Number(canonical.maxTeamPage) < 0) {
          throw new Error("Canonical season status is invalid");
        }
        const expectedPages = Number(canonical.maxTeamPage) + 1;
        const existingManifest = await readJson<{ complete?: boolean; teamCount?: number; pageCount?: number; generation?: number }>(
          store, `discovery/teams/${season}.json`);
        const existingKeys = await readJson<string[]>(store, `registry/teams/${season}.json`);
        let generation: number;
        let teamKeys: string[];
        let failedPages: number[];
        let warnings: string[];
        if (existingManifest?.complete === true && Array.isArray(existingKeys) &&
            existingKeys.length === existingManifest.teamCount && existingManifest.pageCount === expectedPages) {
          generation = Number(existingManifest.generation);
          teamKeys = existingKeys;
          failedPages = [];
          warnings = [];
        } else {
          const resume = await step.do("find-resumable-team-directory", async () => {
            const response = await store.catalog("resume-partial-team-directory", { year: season, expectedPageCount: expectedPages });
            if (!response.ok) throw new Error("Partial team directory lookup returned HTTP " + response.status);
            return response.json() as Promise<{ resumable: boolean; generation?: number; teamKeys?: string[]; failedPages?: number[]; warnings?: string[] }>;
          });
          generation = resume.resumable && Number.isSafeInteger(resume.generation)
            ? Number(resume.generation) : await step.do("allocate-team-directory-generation", async () => Date.now());
          teamKeys = [...(resume.resumable ? resume.teamKeys ?? [] : [])];
          failedPages = [...(resume.resumable ? resume.failedPages ?? [] : Array.from({ length: expectedPages }, (_, i) => i))];
          warnings = [...(resume.resumable ? resume.warnings ?? [] : [])];
          const failed = new Set(failedPages);
          for (let page = 0; page < expectedPages; page++) {
            if (!failed.has(page)) continue;
            try {
              const result = await step.do("discover-team-page-" + page, {
                retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
              }, async () => {
                const response = await store.catalog("discover-team-page", { year: season, generation, page });
                if (!response.ok) throw new Error("Team page " + page + " returned HTTP " + response.status);
                return response.json() as Promise<{ teamKeys: string[] }>;
              });
              teamKeys.push(...result.teamKeys);
              failed.delete(page);
            } catch (error) {
              warnings.push(`Team page ${page} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
            }
          }
          failedPages = [...failed].sort((a, b) => a - b);
          teamKeys = [...new Set(teamKeys)].sort();
          const published = await step.do("publish-team-directory", async () => {
            const response = await store.catalog("publish-team-directory", {
              year: season, generation, pageCount: expectedPages, teamKeys, failedPages, warnings,
            });
            if (!response.ok) throw new Error("Team directory publication returned HTTP " + response.status);
            return response.json() as Promise<{ complete: boolean; status: "completed" | "partial" }>;
          });
          if (!published.complete) {
            await update("record-team-directory-partial", {
              stage: "team_directory_partial", teams: teamKeys.length, team_pages: expectedPages - failedPages.length,
              expected_team_pages: expectedPages, failed_team_pages: failedPages, warnings,
              team_directory_complete: false, team_generation: generation, status: "partial",
            });
            return { year: season, status: "partial", failedPages, teams: teamKeys.length };
          }
        }
        if (teamKeys.length === 0) throw new Error("TBA returned an empty team directory");
        await update("record-team-directory-complete", {
          stage: "registering_teams", teams: teamKeys.length, team_pages: expectedPages,
          expected_team_pages: expectedPages, failed_team_pages: [], warnings,
          team_directory_complete: true, team_generation: generation,
        });
        await child(jobId + "-team-registration-0000", "register-team-batch");
        return { year: season, stage: "registering_teams", teams: teamKeys.length };
      }

      throw new Error("Unsupported season discovery operation: " + String(payload.operation));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await step.do("record-discovery-phase-failure", async () => {
        const current = await readJson<AdminDiscoveryJobRecord>(store, jobKey);
        const failed: AdminDiscoveryJobRecord = {
          year: season, mode: "year", workflow_id: jobId, status: "failed", stage: current?.stage ?? "failed",
          events: current?.events ?? 0, teams: current?.teams ?? 0, team_pages: current?.team_pages ?? 0,
          expected_team_pages: current?.expected_team_pages, failed_team_pages: current?.failed_team_pages,
          warnings: current?.warnings, team_directory_complete: current?.team_directory_complete ?? false,
          team_generation: current?.team_generation, steps: current?.steps ?? 0,
          error: detail.slice(0, 500), started_at: requestedAt, updated_at: Date.now(),
        };
        await store.put(jobKey, JSON.stringify(failed));
        return failed;
      });
      throw error;
    }
  }
}


/** Explicit, year-parameterized discovery Workflow; it does not resolve canonical season. */
export class SeasonDiscoveryWorkflow extends SeasonDiscoveryWorkflowBase {}

/** Season readiness is dispatched through the explicit year-scoped workflows in season-readiness.ts. */

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
        await createDiscoveryServiceClient(this.env).put(allItemsKey, JSON.stringify(items));
        const record: CoverageAuditRecord = {
          year, workflow_id: workflowId, status: "running", started_at: startedAt, updated_at: now,
          cursor: 0, total: items.length, event_discovery_updated_at: directory.eventUpdatedAt,
          team_discovery_updated_at: directory.teamUpdatedAt, items_prefix: itemsPrefix, counts, error: null,
        };
        await createDiscoveryServiceClient(this.env).put(auditKey, JSON.stringify(record));
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
          await createDiscoveryServiceClient(this.env).put(auditKey, JSON.stringify(record));
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
        await createDiscoveryServiceClient(this.env).put(auditKey, JSON.stringify(record));
        return record;
      });
      return { ...completed };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await step.do("record-coverage-audit-failure", async () => {
        const current = await readJson<CoverageAuditRecord>(createDiscoveryServiceClient(this.env), auditKey);
        if (current) await createDiscoveryServiceClient(this.env).put(auditKey, JSON.stringify({
          ...current, status: "failed", error: detail.slice(0, 500), updated_at: Date.now(),
        }));
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
        return Response.json({ ...record, status: mappedStatus, workflow_status: workflowStatus, history_count: history.keys.length }, {
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
          JSON.stringify(previous),
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
      await createDiscoveryServiceClient(env).put(`admin/runtime-jobs/${workflowId}.json`, JSON.stringify(initial));
      await createDiscoveryServiceClient(env).put(indexKey, JSON.stringify({ workflow_id: workflowId }));
      try { await env.RUNTIME_ADMIN.create({ id: workflowId, params }); }
      catch (error) {
        const failed = { ...initial, status: "failed", phase: "failed", errors: [{ key: subject, detail: error instanceof Error ? error.message : String(error), at: Date.now() }] };
        await createDiscoveryServiceClient(env).put(`admin/runtime-jobs/${workflowId}.json`, JSON.stringify(failed));
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
        await createDiscoveryServiceClient(env).put(key, JSON.stringify(current));
        try {
          await env.COVERAGE_AUDIT.create({
            id: workflowId, params: { year, workflowId, startedAt },
          });
        } catch (error) {
          const failed = { ...current, status: "failed" as const,
            error: error instanceof Error ? error.message : String(error), updated_at: Date.now() };
          await createDiscoveryServiceClient(env).put(key, JSON.stringify(failed));
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
      await createDiscoveryServiceClient(env).put(key, JSON.stringify(job));
      try {
        await env.SEASON_DISCOVERY.create({
          id: workflowId,
          params: { operation: "discover-season", year, requestedAt, jobId: workflowId },
        });
      } catch (error) {
        const failed = { ...job, status: "failed" as const, stage: "failed",
          error: error instanceof Error ? error.message : String(error), updated_at: Date.now() };
        await createDiscoveryServiceClient(env).put(key, JSON.stringify(failed));
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
        const recordObject = await store.get<Record<string, unknown>>(`${prefix}/record.json`);
        if (!recordObject) return Response.json({ error: "Workflow run not found" }, { status: 404 });
        const record = recordObject;
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
          await store.put(`${prefix}/record.json`, JSON.stringify(resolvedRecord));
        } else if (workflowStatus === "terminated" && ["running", "queued"].includes(String(record.status))) {
          resolvedRecord = { ...record, status: "cancelled", updated_at: Date.now(), completed_at: Date.now() };
          await store.put(`${prefix}/record.json`, JSON.stringify(resolvedRecord));
        }
        const summaryObject = await store.get<Record<string, unknown>>(`${prefix}/summary.json`);
        const summary = summaryObject;
        const results: unknown[] = [];
        const chunkCount = Number(resolvedRecord.result_chunks ?? 0);
        for (let chunk = 0; chunk < chunkCount; chunk += 1) {
          const object = await store.get<Record<string, unknown>>(`${prefix}/results/${String(chunk).padStart(4, "0")}.json`);
          if (!object) continue;
          const value = object;
          if (Array.isArray(value.results)) results.push(...value.results);
        }
        return Response.json({ ...resolvedRecord, workflow_status: workflowStatus, summary, results }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
      const page = await store.list({ prefix: `admin/workflow-runs/index/${type}/`, limit: 1000 });
      const entries = page.keys.slice(-limit).reverse();
      const runs = (await mapWithConcurrency(entries, 5, async (entry) => {
        const object = await store.get<Record<string, unknown>>(entry);
        if (!object) return null;
        const indexRecord = object ?? {};
        const id = typeof indexRecord.workflow_id === "string" ? indexRecord.workflow_id : "";
        const recordObject = id ? await store.get<Record<string, unknown>>(`admin/workflow-runs/${type}/${id}/record.json`) : null;
        let record = recordObject ?? {};
        if (id && ["running", "queued"].includes(String(record.status))) {
          try {
            const binding = type === "event-readiness" ? env.EVENT_SEASON_READINESS : env.TEAM_SEASON_READINESS;
            const workflowStatus = (await binding.get(id).then((instance) => instance.status())).status;
            if (workflowStatus === "errored" || workflowStatus === "terminated") {
              record = { ...record, status: workflowStatus === "errored" ? "failed" : "cancelled",
                updated_at: Date.now(), completed_at: Date.now(),
                ...(workflowStatus === "errored" ? { error: "Cloudflare Workflow execution failed; inspect the Workflow instance for details." } : {}) };
              await store.put(`admin/workflow-runs/${type}/${id}/record.json`, JSON.stringify(record));
            }
            record = { ...record, workflow_status: workflowStatus };
          } catch { /* Retain the durable run record if the Workflow status API is temporarily unavailable. */ }
        }
        return { ...indexRecord, ...record };
      })).filter((run): run is Record<string, unknown> => run !== null);
      return Response.json({ type, runs, total: page.keys.length }, {
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
