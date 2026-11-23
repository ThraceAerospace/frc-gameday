import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RuntimeEnvironment } from "../../fieldview-runtime/src/cloudflare.ts";
import { dispatchRuntime } from "../../fieldview-runtime/src/runtime-dispatch.ts";

import { classifyEventThisWeek, isValidEventLifecycleInput, lifecycleFor } from "./calendar.ts";
import type { TbaEvent } from "./calendar.ts";
import { RuntimeAdminWorkflow } from "./runtime-admin.ts";
import { createDiscoveryStoreClient, type DiscoveryStoreClient } from "./discovery-store.ts";
import type { RuntimeAdminParameters } from "./runtime-admin.ts";
export { RuntimeAdminWorkflow };

interface DiscoveryDocument {
  year: number;
  events: TbaEvent[];
  chunkCount: number;
  etag: string | null;
  updatedAt: number;
  checkedAt: number;
}

interface JobsEnvironment extends RuntimeEnvironment {
  DAILY_EVENT_READINESS: Workflow;
  COVERAGE_AUDIT: Workflow;
  RUNTIME_ADMIN: Workflow;
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
  status: "running" | "completed" | "failed";
  stage: string;
  events: number;
  teams: number;
  team_pages: number;
  steps: number;
  error: string | null;
  started_at: number;
  updated_at: number;
}

async function readJson<T>(bucket: DiscoveryStoreClient, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? object.json<T>() : null;
}

async function listRuntimeRegistry(bucket: DiscoveryStoreClient, kind: "event" | "team"): Promise<string[]> {
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

async function readPublishedSeason(bucket: DiscoveryStoreClient, year: number): Promise<{
  events: TbaEvent[];
  eventUpdatedAt: number;
  teamKeys: string[];
  teamPageCount: number;
  teamUpdatedAt: number;
} | null> {
  const events = await readJson<DiscoveryDocument>(bucket, `discovery/events/${year}.json`);
  const teamManifest = await readJson<{
    year: number; generation: number; pageCount: number; teamCount: number; updatedAt: number;
  }>(bucket, `discovery/teams/${year}.json`);
  const teamKeys = await readJson<string[]>(bucket, `registry/teams/${year}.json`);
  if (!events || events.year !== year || !Array.isArray(events.events) ||
      events.events.some((item) => !item || typeof item.key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.key)) ||
      !teamManifest || teamManifest.year !== year || !Number.isInteger(teamManifest.pageCount) ||
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

/**
 * Daily discovery and this-week projection now run as a Workflow. EventRuntime
 * remains the owner of canonical event state and active-event polling.
 */
export class LegacyDailyEventReadinessWorkflow extends WorkflowEntrypoint<JobsEnvironment, WorkflowParameters> {
  async run(event: WorkflowEvent<WorkflowParameters>, step: WorkflowStep): Promise<Record<string, unknown>> {
    // The old bulk event-initialization path is intentionally disabled. The
    // replacement DailyEventReadinessWorkflow owns the scheduled readiness sweep.
    if (event.payload?.operation !== "discover-season") {
      throw new Error("Legacy bulk readiness execution is disabled");
    }
    return this.discoverSeason(event.payload, step);
    const runAt = event.payload?.scheduledAt ?? event.schedule?.scheduledTime ?? Date.now();
    const runDate = new Date(runAt).toISOString().slice(0, 10);

    // TBA is the authority for the current FRC season. Never derive this from
    // the Worker clock: the season boundary follows the official kickoff.
    const currentSeason = await step.do("resolve-current-tba-season", {
      retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
    }, async () => {
      const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("resolve-current-season");
      if (!response.ok) throw new Error("DiscoveryStore current-season resolution returned HTTP " + response.status);
      return response.json() as Promise<{ year: number; checkedAt: number; fallback?: boolean }>;
    });
    const years = [currentSeason.year];

    // Orchestrate current-season team directory acquisition through DiscoveryStore.
    // DiscoveryStore validates and persists each page, then publishes the manifest
    // only after every page has been validated.
    const teamDirectoryGeneration = await step.do("create-team-directory-generation", async () => Date.now());
    let teamPageCount = 0;
    let teamCount = 0;
    const discoveredTeamKeys: string[] = [];
    for (let page = 0; ; page += 1) {
      const pageResult = await step.do(`discover-team-directory-${currentSeason.year}-${page}`, {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
        const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("discover-team-page", {
          year: currentSeason.year, generation: teamDirectoryGeneration, page,
        });
        if (!response.ok) throw new Error("DiscoveryStore team page acquisition returned HTTP " + response.status);
        return response.json() as Promise<{
          page: number; count: number; hasMore: boolean; teamKeys: string[];
        }>;
      });
      teamPageCount += 1;
      teamCount += pageResult.count;
      discoveredTeamKeys.push(...pageResult.teamKeys);
      if (!pageResult.hasMore) break;
    }
    const uniqueCurrentSeasonTeamKeys = [...new Set(discoveredTeamKeys)].sort();
    teamCount = uniqueCurrentSeasonTeamKeys.length;
    await step.do("publish-current-season-team-directory", async () => {
      const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("publish-team-directory", {
        year: currentSeason.year, generation: teamDirectoryGeneration,
        pageCount: teamPageCount, teamKeys: uniqueCurrentSeasonTeamKeys,
      });
      if (!response.ok) throw new Error("DiscoveryStore team directory publication returned HTTP " + response.status);
      return response.json();
    });

    const discovery: Array<{ year: number; count: number; checkedAt: number; generation: number; chunkCount: number; needsChunking: boolean }> = [];
    const eventChunkSize = 25;
    for (const year of years) {
      const result = await step.do(`discover-event-directory-${year}`, {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
        const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("discover-event-directory", {
          year, chunkSize: eventChunkSize,
        });
        if (!response.ok) throw new Error("DiscoveryStore event directory acquisition returned HTTP " + response.status);
        return response.json() as Promise<{
          year: number; count: number; checkedAt: number; generation: number;
          chunkCount: number; needsChunking: boolean;
        }>;
      });
      discovery.push(result);
    }

    for (const directory of discovery) {
      if (directory.needsChunking) {
        for (let firstChunk = 0; firstChunk < directory.chunkCount; firstChunk += 10) {
          const endChunk = Math.min(directory.chunkCount, firstChunk + 10);
          await step.do(`write-event-chunks-${directory.year}-${firstChunk}`, async () => {
            const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("write-event-chunks", {
              year: directory.year, generation: directory.generation,
              firstChunk, endChunk, chunkSize: eventChunkSize,
            });
            if (!response.ok) throw new Error("DiscoveryStore event chunk write returned HTTP " + response.status);
            return response.json();
          });
        }
        await step.do(`publish-event-directory-${directory.year}`, async () => {
          const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("publish-event-directory", {
            year: directory.year, generation: directory.generation,
          });
          if (!response.ok) throw new Error("DiscoveryStore event directory publication returned HTTP " + response.status);
          return response.json();
        });
      }
    }

    const classified: Array<{
      year: number;
      eventRefs: Array<{ key: string; lifecycle: ReturnType<typeof lifecycleFor> }>;
      lifecycleRefs: Array<{ key: string; lifecycle: ReturnType<typeof lifecycleFor> }>;
    }> = [];
    for (const directory of discovery) {
      const yearMatches: TbaEvent[] = [];
      const yearLifecycleRefs: Array<{ key: string; lifecycle: ReturnType<typeof lifecycleFor> }> = [];
      for (let chunkIndex = 0; chunkIndex < directory.chunkCount; chunkIndex += 1) {
        const classification = await step.do(`classify-this-week-and-lifecycle-${directory.year}-${chunkIndex}`, async () => {
          const object = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).get(
            `discovery/event-chunks/${directory.year}/${directory.generation}/${chunkIndex}.json`,
          );
          if (!object) throw new Error(`Missing event discovery chunk ${directory.year}/${chunkIndex}`);
          const chunk = await object.json<TbaEvent[]>();
          return {
            thisWeek: chunk.filter((item) => classifyEventThisWeek(item, runAt)?.isThisWeek === true),
            lifecycle: chunk.flatMap((item) => {
              const lifecycle = lifecycleFor(item, runAt);
              return lifecycle.lifecycle === "expired" ? [] : [{ key: item.key, lifecycle }];
            }),
          };
        });
        yearMatches.push(...classification.thisWeek);
        yearLifecycleRefs.push(...classification.lifecycle);
      }
      await step.do(`publish-this-week-year-${directory.year}`, async () => {
        const projection = {
          evaluatedAt: runAt,
          runDate,
          checkedAt: directory.checkedAt,
          events: yearMatches,
        };
        await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(
          `projections/events/this-week/${runAt}/${directory.year}.json`,
          JSON.stringify(projection),
          { httpMetadata: { contentType: "application/json" } },
        );
        return { year: directory.year, eventCount: yearMatches.length };
      });
      classified.push({
        year: directory.year,
        eventRefs: yearMatches.map((item) => ({ key: item.key, lifecycle: lifecycleFor(item, runAt) })),
        lifecycleRefs: yearLifecycleRefs,
      });
    }

    // EventRuntime owns the event-participant resource and its provider I/O.
    // The Workflow only asks for readiness and coordinates the resulting teams.
    const participantKeys = new Set<string>();
    const eventRefs = classified.flatMap(({ eventRefs: items }) => items);
    const participantFailures: Array<{ event_key: string; error: string }> = [];
    for (const item of eventRefs) {
      try {
        let teamKeys: string[] | null = null;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const result = await step.do(`discover-participants-${item.key}-${attempt}`, async () => {
            const response = await dispatchRuntime(
              this.env, "event", item.key, "participants", {}, currentSeason.year,
            );
            if (response.status === 202) return { ready: false, team_keys: [] as string[] };
            if (!response.ok) {
              throw new Error(`EventRuntime participant lookup for ${item.key} returned HTTP ${response.status}`);
            }
            const value = await response.json() as { ready?: unknown; team_keys?: unknown };
            if (value.ready !== true || !Array.isArray(value.team_keys) ||
                value.team_keys.some((key) => typeof key !== "string" || !/^frc[0-9]+$/.test(key))) {
              throw new Error(`EventRuntime returned an invalid participant roster for ${item.key}`);
            }
            return { ready: true, team_keys: [...new Set(value.team_keys as string[])].sort() };
          });
          if (result.ready) {
            teamKeys = result.team_keys;
            break;
          }
          await step.sleep(`wait-event-participants-${item.key}-${attempt}`, "30 seconds");
        }
        if (teamKeys === null) throw new Error(`Timed out waiting for EventRuntime participants for ${item.key}`);
        teamKeys.forEach((teamKey) => participantKeys.add(teamKey));
      } catch (error) {
        participantFailures.push({ event_key: item.key, error: String(error) });
      }
    }

    const teamKeys = [...participantKeys].sort();
    const seededTeams: string[] = [];
    const failedTeams: Array<{ team_key: string; error: string }> = [];
    for (let offset = 0; offset < teamKeys.length; offset += 10) {
      const batch = teamKeys.slice(offset, offset + 10);
      try {
        const result = await step.do(`seed-team-runtimes-${offset / 10}`, {
          retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
        }, async () => {
          const seeded: string[] = [];
          const failed: Array<{ team_key: string; error: string }> = [];
          for (const teamKey of batch) {
            const response = await dispatchRuntime(
              this.env, "team", teamKey, "seed", {}, currentSeason.year,
            );
            if (response.status === 401 || response.status === 403 || response.status === 404) {
              throw new Error(`TeamRuntime seed boundary returned HTTP ${response.status} for ${teamKey}`);
            }
            if (response.status === 429 || response.status >= 500) {
              throw new Error(`Transient TeamRuntime response HTTP ${response.status} for ${teamKey}`);
            }
            if (!response.ok && response.status !== 202) {
              failed.push({ team_key: teamKey, error: `Runtime returned HTTP ${response.status}` });
            } else {
              seeded.push(teamKey);
            }
          }
          for (const teamKey of seeded) {
            await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(`registry/runtime-teams/${teamKey}.json`, "{}", {
              httpMetadata: { contentType: "application/json" },
            });
          }
          return { seeded, failed };
        });
        seededTeams.push(...result.seeded);
        failedTeams.push(...result.failed);
      } catch (error) {
        if (String(error).includes("TeamRuntime seed boundary returned HTTP")) throw error;
        failedTeams.push(...batch.map((team_key) => ({ team_key, error: String(error) })));
      }
    }

    const prepared = await step.do("write-this-week-manifest", async () => {
      const manifestKey = `workflows/daily-event-readiness/${runAt}/events.json`;
      const eventRefs = classified.flatMap(({ year, eventRefs: items }) =>
        items.map(({ key, lifecycle }) => ({ year, key, ...lifecycle })));
      await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(manifestKey, JSON.stringify(eventRefs), {
        httpMetadata: { contentType: "application/json" },
      });
      return { manifestKey, eventCount: eventRefs.length, runDate };
    });

    const keys = classified.flatMap(({ year, lifecycleRefs }) =>
      lifecycleRefs.map(({ key, lifecycle }) => ({ year, key, lifecycle })));
    const initialized: string[] = [];
    const failures: Array<{ event_key: string; error: string }> = [];
    for (let offset = 0; offset < keys.length; offset += 10) {
      const batch = keys.slice(offset, offset + 10);
      try {
        const result = await step.do(`initialize-events-${offset / 10}`, {
          retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
        }, async () => {
          const batchInitialized: string[] = [];
          const batchFailures: Array<{ event_key: string; error: string }> = [];
          for (const item of batch) {
            const response = await dispatchRuntime(
              this.env, "event", item.key, "lifecycle", item.lifecycle as unknown as Record<string, unknown>, item.year,
            );
            if (response.status === 401 || response.status === 403 || response.status === 404) {
              throw new Error(`Runtime initialization boundary returned HTTP ${response.status} for ${item.key}; check deployment and shared admin authorization`);
            }
            if (response.status === 429 || response.status >= 500) {
              throw new Error(`Transient runtime response HTTP ${response.status} for ${item.key}`);
            }
            if (!response.ok) batchFailures.push({ event_key: item.key, error: `Runtime returned HTTP ${response.status}` });
            else batchInitialized.push(item.key);
          }
          for (const eventKey of batchInitialized) {
            await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(`registry/runtime-events/${eventKey}.json`, "{}", {
              httpMetadata: { contentType: "application/json" },
            });
          }
          return { initialized: batchInitialized, failures: batchFailures };
        });
        initialized.push(...result.initialized);
        failures.push(...result.failures);
      } catch (error) {
        if (String(error).includes("Runtime initialization boundary returned HTTP")) throw error;
        failures.push(...batch.map((item) => ({ event_key: item.key, error: String(error) })));
      }
    }

    await step.do("publish-this-week-generation", async () => {
      const pointer = { runAt, runDate: prepared.runDate, years };
      await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(
        "projections/events/this-week/current.json",
        JSON.stringify(pointer),
        { httpMetadata: { contentType: "application/json" } },
      );
      return { published: true, eventCount: prepared.eventCount };
    });

    const summary = {
      run_date: prepared.runDate,
      current_season: currentSeason.year,
      season_source: currentSeason.fallback ? "last-known-good" : "tba-status",
      discovery: discovery.map(({ year, count }) => ({ year, count })),
      this_week_events: prepared.eventCount,
      team_directory: { pages: teamPageCount, teams: teamCount },
      participant_teams: teamKeys.length,
      teams_seeded: seededTeams.length,
      teams_failed: failedTeams.length,
      team_seed_failures: failedTeams.slice(0, 100),
      participant_discovery_failures: participantFailures.slice(0, 100),
      initialized: initialized.length,
      failed: failures.length,
      failures: failures.slice(0, 100),
    };
    await step.do("write-run-summary", async () => {
      await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(
        `workflows/daily-event-readiness/${runAt}/summary.json`,
        JSON.stringify(summary),
        { httpMetadata: { contentType: "application/json" } },
      );
      return summary;
    });
    return summary;
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
        const current = await readJson<AdminDiscoveryJobRecord>(createDiscoveryStoreClient(this.env.DISCOVERY_STORE), jobKey);
        const defaults: AdminDiscoveryJobRecord = {
          year: season, mode: "year", workflow_id: jobId, status: "running", stage: "starting",
          events: 0, teams: 0, team_pages: 0, steps: 0, error: null,
          started_at: requestedAt, updated_at: Date.now(),
        };
        const next: AdminDiscoveryJobRecord = {
          ...defaults, ...(current ?? {}), ...patch,
          ...{ workflow_id: jobId, year: season, updated_at: Date.now() },
        };
        await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(jobKey, JSON.stringify(next), {
          httpMetadata: { contentType: "application/json" },
        });
        return next;
      });

    try {
      await updateJob("record-discovery-started", { stage: "discovering_events" });
      const generation = await step.do("allocate-season-directory-generation", async () => Date.now());
      const eventChunkSize = 25;
      const eventDirectory = await step.do("discover-manual-season-events", {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
        const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("discover-event-directory", {
          year: season, generation, chunkSize: eventChunkSize,
        });
        if (!response.ok) throw new Error("DiscoveryStore event directory acquisition returned HTTP " + response.status);
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
            const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("write-event-chunks", {
              year: season, generation: eventDirectory.generation,
              firstChunk, endChunk, chunkSize: eventChunkSize,
            });
            if (!response.ok) throw new Error("DiscoveryStore event chunk write returned HTTP " + response.status);
            return response.json();
          });
        }
        await step.do("publish-manual-event-directory", async () => {
          const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("publish-event-directory", {
            year: season, generation: eventDirectory.generation,
          });
          if (!response.ok) throw new Error("DiscoveryStore event directory publication returned HTTP " + response.status);
          return response.json();
        });
      }

      const teamGeneration = await step.do("allocate-manual-team-directory-generation", async () => Date.now());
            const teamKeys: string[] = [];
      let teamPages = 0;
      for (let page = 0; page < 100; page += 1) {
        const result = await step.do(`discover-manual-team-page-${page}`, {
          retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
        }, async () => {
          const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("discover-team-page", {
            year: season, generation: teamGeneration, page,
          });
          if (!response.ok) throw new Error("DiscoveryStore team page acquisition returned HTTP " + response.status);
          return response.json() as Promise<{ teamKeys: string[]; count: number; hasMore: boolean }>;
        });
        teamKeys.push(...result.teamKeys);
        teamPages += 1;
        if (!result.hasMore) break;
        if (page === 99) throw new Error("TBA team discovery exceeded the 100-page season limit");
      }
      const uniqueTeamKeys = [...new Set(teamKeys)].sort();
      if (uniqueTeamKeys.length === 0) throw new Error("TBA returned an empty team directory for the selected season");
      await updateJob("record-team-discovery-progress", {
        stage: "publishing_teams", teams: uniqueTeamKeys.length, team_pages: teamPages,
        steps: 3 + teamPages,
      });
      await step.do("publish-manual-team-directory", async () => {
        const response = await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).catalog("publish-team-directory", {
          year: season, generation: teamGeneration, pageCount: teamPages, teamKeys: uniqueTeamKeys,
        });
        if (!response.ok) throw new Error("DiscoveryStore team directory publication returned HTTP " + response.status);
        return response.json();
      });
      const summary = {
        year: season, mode: "year", workflow_id: jobId, status: "completed", stage: "complete",
        events: eventDirectory.count, teams: uniqueTeamKeys.length, team_pages: teamPages,
        steps: 4 + teamPages + (eventDirectory.needsChunking ? Math.ceil(eventDirectory.chunkCount / 10) + 1 : 0),
        error: null, started_at: requestedAt, updated_at: Date.now(),
      };
      await step.do("publish-manual-discovery-summary", async () => {
        await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(jobKey, JSON.stringify(summary), {
          httpMetadata: { contentType: "application/json" },
        });
        return summary;
      });
      return summary;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await step.do("record-manual-discovery-failure", async () => {
        const current = await readJson<AdminDiscoveryJobRecord>(createDiscoveryStoreClient(this.env.DISCOVERY_STORE), jobKey);
        const failed: AdminDiscoveryJobRecord = {
          year: season, mode: "year", workflow_id: jobId, status: "failed", stage: current?.stage ?? "failed",
          events: current?.events ?? 0, teams: current?.teams ?? 0, team_pages: current?.team_pages ?? 0,
          steps: current?.steps ?? 0, error: detail.slice(0, 500),
          started_at: requestedAt, updated_at: Date.now(),
        };
        await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(jobKey, JSON.stringify(failed), {
          httpMetadata: { contentType: "application/json" },
        });
        return failed;
      });
      throw error;
    }
  }
}


/**
 * Sequential readiness sweep. The Workflow never acquires entity resources:
 * each runtime inspects its own durable publication and queues local refreshes.
 */
export class DailyEventReadinessWorkflow extends LegacyDailyEventReadinessWorkflow {
  override async run(
    event: WorkflowEvent<WorkflowParameters>,
    step: WorkflowStep,
  ): Promise<Record<string, unknown>> {
    // Preserve the explicit admin season-discovery operation. The legacy class
    // handles only that separate operation; the daily path below is replaced.
    if (event.payload?.operation === "discover-season") return super.run(event, step);

    const runAt = event.payload?.scheduledAt ?? event.schedule?.scheduledTime ?? Date.now();
    const runDate = new Date(runAt).toISOString().slice(0, 10);
    const store = () => createDiscoveryStoreClient(this.env.DISCOVERY_STORE);

    const currentSeason = await step.do("readiness-resolve-current-season", {
      retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
    }, async () => {
      const response = await store().catalog("resolve-current-season");
      if (!response.ok) throw new Error("Current-season resolution returned HTTP " + response.status);
      return response.json() as Promise<{ year: number; checkedAt: number; fallback?: boolean }>;
    });
    const year = currentSeason.year;

    // Refresh the canonical team directory before checking any TeamRuntime.
    const teamGeneration = await step.do("readiness-team-directory-generation", async () => Date.now());
    const teamKeys: string[] = [];
    let teamPages = 0;
    for (let page = 0; ; page += 1) {
      const result = await step.do("readiness-discover-team-page-" + page, {
        retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
        const response = await store().catalog("discover-team-page", { year, generation: teamGeneration, page });
        if (!response.ok) throw new Error("Team directory page returned HTTP " + response.status);
        return response.json() as Promise<{ teamKeys: string[]; hasMore: boolean; count: number }>;
      });
      teamPages += 1;
      teamKeys.push(...result.teamKeys);
      if (!result.hasMore) break;
    }
    const uniqueTeamKeys = [...new Set(teamKeys)].sort();
    await step.do("readiness-publish-team-directory", async () => {
      const response = await store().catalog("publish-team-directory", {
        year, generation: teamGeneration, pageCount: teamPages, teamKeys: uniqueTeamKeys,
      });
      if (!response.ok) throw new Error("Team directory publication returned HTTP " + response.status);
      return response.json();
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

    const thisWeekEvents = eventKeys.filter((item) =>
      item && typeof item.key === "string" && /^[a-zA-Z0-9_-]+$/.test(item.key) &&
      classifyEventThisWeek(item, runAt)?.isThisWeek,
    );
    const eventResults: Array<{ key: string; state_valid: boolean; refresh_queued: boolean; error?: string }> = [];
    for (const item of eventKeys) {
      if (!item || typeof item.key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.key)) continue;
      try {
        const refreshAt = await step.do("readiness-event-refresh-time-" + item.key, async () =>
          Date.now() + Math.floor(Math.random() * 5 * 60_000));
        const result = await step.do("readiness-inspect-event-" + item.key, {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        }, async () => {
          const response = await dispatchRuntime(this.env, "event", item.key, "readiness", { refreshAt }, year);
          if (!response.ok) throw new Error("EventRuntime readiness returned HTTP " + response.status + ": " + await response.text());
          return response.json() as Promise<{ state_valid?: boolean; refresh_queued?: boolean }>;
        });
        eventResults.push({
          key: item.key,
          state_valid: result.state_valid === true,
          refresh_queued: result.refresh_queued === true,
        });
      } catch (error) {
        eventResults.push({ key: item.key, state_valid: false, refresh_queued: false, error: String(error).slice(0, 300) });
      }
    }

    // Team readiness follows the same sequential, delayed pattern. It checks
    // every current-season team, not only teams participating in this week's events.
    const teamResults: Array<{ key: string; state_valid: boolean; refresh_queued: boolean; error?: string }> = [];
    for (const teamKey of uniqueTeamKeys) {
      try {
        const refreshAt = await step.do("readiness-team-refresh-time-" + teamKey, async () =>
          Date.now() + Math.floor(Math.random() * 5 * 60_000));
        const result = await step.do("readiness-inspect-team-" + teamKey, {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
        }, async () => {
          const response = await dispatchRuntime(this.env, "team", teamKey, "readiness", { refreshAt }, year);
          if (!response.ok) throw new Error("TeamRuntime readiness returned HTTP " + response.status + ": " + await response.text());
          return response.json() as Promise<{ state_valid?: boolean; refresh_queued?: boolean }>;
        });
        teamResults.push({
          key: teamKey,
          state_valid: result.state_valid === true,
          refresh_queued: result.refresh_queued === true,
        });
      } catch (error) {
        teamResults.push({ key: teamKey, state_valid: false, refresh_queued: false, error: String(error).slice(0, 300) });
      }
    }

    const thisWeekProjection = {
      evaluatedAt: runAt,
      runDate,
      checkedAt: eventDirectory.checkedAt,
      events: thisWeekEvents,
    };
    await step.do("readiness-publish-this-week-projection", async () => {
      await store().put(
        `projections/events/this-week/${runAt}/${year}.json`,
        JSON.stringify(thisWeekProjection),
        { httpMetadata: { contentType: "application/json" } },
      );
      await store().put("projections/events/this-week/current.json", JSON.stringify({
        runAt, runDate, years: [year],
      }), { httpMetadata: { contentType: "application/json" } });
      return { eventCount: thisWeekEvents.length };
    });

    const summary = {
      run_date: runDate,
      current_season: year,
      season_source: currentSeason.fallback ? "last-known-good" : "tba-status",
      events_total: eventKeys.length,
      events_state_valid: eventResults.filter((item) => item.state_valid).length,
      events_refresh_queued: eventResults.filter((item) => item.refresh_queued).length,
      events_failed: eventResults.filter((item) => item.error).length,
      event_failures: eventResults.filter((item) => item.error).slice(0, 100),
      teams_total: uniqueTeamKeys.length,
      teams_state_valid: teamResults.filter((item) => item.state_valid).length,
      teams_refresh_queued: teamResults.filter((item) => item.refresh_queued).length,
      teams_failed: teamResults.filter((item) => item.error).length,
      team_failures: teamResults.filter((item) => item.error).slice(0, 100),
      this_week_events: thisWeekEvents.length,
      team_directory: { pages: teamPages, teams: uniqueTeamKeys.length },
      event_directory: { count: eventDirectory.count, generation: eventDirectory.generation },
    };
    await step.do("readiness-write-run-summary", async () => {
      await store().put(
        `workflows/daily-event-readiness/${runAt}/summary.json`,
        JSON.stringify(summary),
        { httpMetadata: { contentType: "application/json" } },
      );
      return summary;
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
        const directory = await readPublishedSeason(createDiscoveryStoreClient(this.env.DISCOVERY_STORE), year);
        if (!directory) throw new Error("Complete event and paginated team discovery is required before starting the coverage audit");
        const now = Date.now();
        const runtimeEvents = new Set(await listRuntimeRegistry(createDiscoveryStoreClient(this.env.DISCOVERY_STORE), "event"));
        const runtimeTeams = new Set(await listRuntimeRegistry(createDiscoveryStoreClient(this.env.DISCOVERY_STORE), "team"));
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
        await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(allItemsKey, JSON.stringify(items), {
          httpMetadata: { contentType: "application/json" },
        });
        const record: CoverageAuditRecord = {
          year, workflow_id: workflowId, status: "running", started_at: startedAt, updated_at: now,
          cursor: 0, total: items.length, event_discovery_updated_at: directory.eventUpdatedAt,
          team_discovery_updated_at: directory.teamUpdatedAt, items_prefix: itemsPrefix, counts, error: null,
        };
        await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(auditKey, JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
        });
        return { total: items.length, chunkCount: Math.ceil(items.length / 100), counts, itemsPrefix, record };
      });

      for (let firstChunk = 0; firstChunk < prepared.chunkCount; firstChunk += 10) {
        const endChunk = Math.min(prepared.chunkCount, firstChunk + 10);
        await step.do(`write-coverage-audit-items-${firstChunk}`, async () => {
          const allItems = await readJson<CoverageAuditItem[]>(createDiscoveryStoreClient(this.env.DISCOVERY_STORE), prepared.itemsPrefix + "all.json");
          if (!allItems || allItems.length !== prepared.total) throw new Error("Coverage audit item manifest is missing or incomplete");
          for (let chunk = firstChunk; chunk < endChunk; chunk += 1) {
            await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(
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
          const chunk = await readJson<CoverageAuditItem[]>(createDiscoveryStoreClient(this.env.DISCOVERY_STORE), prepared.itemsPrefix + `${chunkIndex}.json`);
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
          await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(auditKey, JSON.stringify(record), {
            httpMetadata: { contentType: "application/json" },
          });
          return { cursor: nextCursor, counts: nextCounts };
        });
        cursor = batchResult.cursor;
        counts = batchResult.counts;
      }

      const completed = await step.do("complete-coverage-audit", async () => {
        const current = await readPublishedSeason(createDiscoveryStoreClient(this.env.DISCOVERY_STORE), year);
        const stale = !current ||
          current.eventUpdatedAt !== prepared.record.event_discovery_updated_at ||
          current.teamUpdatedAt !== prepared.record.team_discovery_updated_at;
        const record: CoverageAuditRecord = {
          ...prepared.record, cursor, counts, status: stale ? "stale" : "completed",
          updated_at: Date.now(), error: null,
        };
        await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(auditKey, JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
        });
        return record;
      });
      return { ...completed };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await step.do("record-coverage-audit-failure", async () => {
        const current = await readJson<CoverageAuditRecord>(createDiscoveryStoreClient(this.env.DISCOVERY_STORE), auditKey);
        if (current) await createDiscoveryStoreClient(this.env.DISCOVERY_STORE).put(auditKey, JSON.stringify({
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
    if (url.pathname === "/health") return Response.json({ service: "fieldview-jobs", status: "ok" });
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
      let pointer = await readJson<{ workflow_id: string }>(createDiscoveryStoreClient(env.DISCOVERY_STORE), indexKey);
      if (request.method === "GET") {
        if (!pointer) return Response.json({ year, operation, status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
        const record = await readJson<Record<string, unknown>>(createDiscoveryStoreClient(env.DISCOVERY_STORE), `admin/runtime-jobs/${pointer.workflow_id}.json`);
        if (!record) return Response.json({ year, operation, status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
        let workflowStatus: string | null = null;
        try { workflowStatus = (await (await env.RUNTIME_ADMIN.get(pointer.workflow_id)).status()).status; } catch { workflowStatus = null; }
        const mappedStatus = workflowStatus === "paused" ? "paused"
          : workflowStatus === "terminated" ? "cancelled"
          : workflowStatus === "errored" ? "failed"
          : workflowStatus === "complete" ? record.status : record.status;
        const history = await createDiscoveryStoreClient(env.DISCOVERY_STORE).list({ prefix: `admin/runtime-job-history/${operation}/${subject}/`, limit: 1000 });
        return Response.json({ ...record, status: mappedStatus, workflow_status: workflowStatus, history_count: history.objects.length }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      let action = String(value.action ?? "start");
      let retryingPartial = false;
      if (!["start", "pause", "resume", "cancel", "preview"].includes(action)) return Response.json({ error: "Invalid runtime job action" }, { status: 400 });
      if (action === "resume" && pointer) {
        const prior = await readJson<Record<string, unknown>>(createDiscoveryStoreClient(env.DISCOVERY_STORE), `admin/runtime-jobs/${pointer.workflow_id}.json`);
        const priorStatus = await env.RUNTIME_ADMIN.get(pointer.workflow_id).then((instance) => instance.status()).catch(() => null);
        if (prior?.status === "completed_with_errors" && priorStatus?.status === "complete") {
          action = "start";
          retryingPartial = true;
        }
      }
      if (action === "preview") {
        const events = await readJson<DiscoveryDocument>(createDiscoveryStoreClient(env.DISCOVERY_STORE), `discovery/events/${year}.json`);
        const teams = await readJson<string[]>(createDiscoveryStoreClient(env.DISCOVERY_STORE), `registry/teams/${year}.json`);
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
        const previous = await readJson<Record<string, unknown>>(createDiscoveryStoreClient(env.DISCOVERY_STORE), `admin/runtime-jobs/${pointer.workflow_id}.json`);
        if (previous) await createDiscoveryStoreClient(env.DISCOVERY_STORE).put(
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
      await createDiscoveryStoreClient(env.DISCOVERY_STORE).put(`admin/runtime-jobs/${workflowId}.json`, JSON.stringify(initial), { httpMetadata: { contentType: "application/json" } });
      await createDiscoveryStoreClient(env.DISCOVERY_STORE).put(indexKey, JSON.stringify({ workflow_id: workflowId }), { httpMetadata: { contentType: "application/json" } });
      try { await env.RUNTIME_ADMIN.create({ id: workflowId, params }); }
      catch (error) {
        const failed = { ...initial, status: "failed", phase: "failed", errors: [{ key: subject, detail: error instanceof Error ? error.message : String(error), at: Date.now() }] };
        await createDiscoveryStoreClient(env.DISCOVERY_STORE).put(`admin/runtime-jobs/${workflowId}.json`, JSON.stringify(failed), { httpMetadata: { contentType: "application/json" } });
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
      const record = await readJson<CoverageAuditRecord>(createDiscoveryStoreClient(env.DISCOVERY_STORE), `admin/coverage-audits/${year}.json`);
      const discoveryReady = (await readPublishedSeason(createDiscoveryStoreClient(env.DISCOVERY_STORE), year)) !== null;
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
      let current = await readJson<CoverageAuditRecord>(createDiscoveryStoreClient(env.DISCOVERY_STORE), key);
      if (action === "start") {
        const directory = await readPublishedSeason(createDiscoveryStoreClient(env.DISCOVERY_STORE), year);
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
          await createDiscoveryStoreClient(env.DISCOVERY_STORE).put(
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
        await createDiscoveryStoreClient(env.DISCOVERY_STORE).put(key, JSON.stringify(current), {
          httpMetadata: { contentType: "application/json" },
        });
        try {
          await env.COVERAGE_AUDIT.create({
            id: workflowId, params: { year, workflowId, startedAt },
          });
        } catch (error) {
          const failed = { ...current, status: "failed" as const,
            error: error instanceof Error ? error.message : String(error), updated_at: Date.now() };
          await createDiscoveryStoreClient(env.DISCOVERY_STORE).put(key, JSON.stringify(failed), {
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
      const job = await readJson<AdminDiscoveryJobRecord>(createDiscoveryStoreClient(env.DISCOVERY_STORE), `admin/discovery-jobs/${year}.json`);
      if (!job) return Response.json({ year, status: "not_started" }, { headers: { "Cache-Control": "no-store" } });
      let workflowStatus: string | null = null;
      try {
        const instance = await env.DAILY_EVENT_READINESS.get(job.workflow_id);
        workflowStatus = (await instance.status()).status;
      } catch { workflowStatus = null; }
      const status = workflowStatus === "paused" ? "paused"
        : workflowStatus === "errored" ? "failed"
        : workflowStatus === "terminated" ? "cancelled"
        : workflowStatus === "complete" ? "completed"
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
      const current = await readJson<AdminDiscoveryJobRecord>(createDiscoveryStoreClient(env.DISCOVERY_STORE), key);
      if (current?.status === "running") {
        try {
          const instance = await env.DAILY_EVENT_READINESS.get(current.workflow_id);
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
      await createDiscoveryStoreClient(env.DISCOVERY_STORE).put(key, JSON.stringify(job), {
        httpMetadata: { contentType: "application/json" },
      });
      try {
        await env.DAILY_EVENT_READINESS.create({
          id: workflowId,
          params: { operation: "discover-season", year, requestedAt, jobId: workflowId },
        });
      } catch (error) {
        const failed = { ...job, status: "failed" as const, stage: "failed",
          error: error instanceof Error ? error.message : String(error), updated_at: Date.now() };
        await createDiscoveryStoreClient(env.DISCOVERY_STORE).put(key, JSON.stringify(failed), {
          httpMetadata: { contentType: "application/json" },
        });
        return Response.json(failed, { status: 409 });
      }
      return Response.json(job, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/internal/admin/daily-event-readiness" && request.method === "POST") {
      if (!env.RUNTIME_ADMIN_TOKEN ||
          request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const scheduledAt = Date.now();
      const id = `daily-event-readiness-${new Date(scheduledAt).toISOString().slice(0, 10)}`;
      try {
        await env.DAILY_EVENT_READINESS.create({ id, params: { scheduledAt } });
      } catch {
        return Response.json({ error: "A daily event-readiness Workflow already exists for this UTC date", workflow_id: id }, { status: 409 });
      }
      return Response.json({ workflow_id: id, scheduled_at: scheduledAt }, { status: 202 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },

};
