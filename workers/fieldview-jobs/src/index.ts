import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { TBAApiClient } from "../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";

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
  COVERAGE_AUDIT: Workflow;
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

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? object.json<T>() : null;
}

async function listRuntimeRegistry(bucket: R2Bucket, kind: "event" | "team"): Promise<string[]> {
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

async function readPublishedSeason(bucket: R2Bucket, year: number): Promise<{
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
export class DailyEventReadinessWorkflow extends WorkflowEntrypoint<JobsEnvironment, WorkflowParameters> {
  async run(event: WorkflowEvent<WorkflowParameters>, step: WorkflowStep): Promise<Record<string, unknown>> {
    if (event.payload?.operation === "discover-season") {
      return this.discoverSeason(event.payload, step);
    }
    const runAt = event.payload?.scheduledAt ?? event.schedule?.scheduledTime ?? Date.now();
    const runDate = new Date(runAt).toISOString().slice(0, 10);

    // TBA is the authority for the current FRC season. Never derive this from
    // the Worker clock: the season boundary follows the official kickoff.
    const currentSeason = await step.do("resolve-current-tba-season", {
      retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
    }, async () => {
      const known = await readJson<{ year: number; checkedAt: number }>(
        this.env.DISCOVERY_BUCKET, "discovery/current-season.json",
      );
      try {
        const api = new TBAApiClient({ apiKey: this.env.TBA_API_KEY });
        const response = await api.request(TBA_ENDPOINTS.status());
        if (!response.ok) throw new Error(`TBA status returned HTTP ${response.status}`);
        const status = await response.json() as { current_season?: unknown };
        const raw = status?.current_season;
        const year = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
        if (!Number.isInteger(year) || year < 1992 || year > 2200) {
          throw new Error("TBA status returned an invalid current_season");
        }
        const resolved = { year, checkedAt: Date.now() };
        await this.env.DISCOVERY_BUCKET.put("discovery/current-season.json", JSON.stringify(resolved), {
          httpMetadata: { contentType: "application/json" },
        });
        return resolved;
      } catch (error) {
        if (known && Number.isInteger(known.year) && known.year >= 1992 && known.year <= 2200) {
          return { ...known, fallback: true };
        }
        throw error;
      }
    });
    const years = [currentSeason.year];

    // Publish the current-season team directory from TBA's paginated endpoint.
    // Each page is an immutable R2 object; the manifest is the publication
    // boundary and is written only after every page has been validated.
    const teamDirectoryGeneration = await step.do("create-team-directory-generation", async () => Date.now());
    const teamPageSize = 500;
    let teamPageCount = 0;
    let teamCount = 0;
    const discoveredTeamKeys: string[] = [];
    for (let page = 0; ; page += 1) {
      const pageResult = await step.do(`discover-team-directory-${currentSeason.year}-${page}`, {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
        const api = new TBAApiClient({ apiKey: this.env.TBA_API_KEY });
        const response = await api.request(TBA_ENDPOINTS.teamsByYearPage(currentSeason.year, page));
        if (!response.ok) throw new Error(`TBA team discovery page ${page} returned HTTP ${response.status}`);
        const teams = await response.json() as Array<{ key?: unknown }>;
        if (!Array.isArray(teams) || teams.some((team) =>
          !team || typeof team.key !== "string" || !/^frc[0-9]+$/.test(team.key))) {
          throw new Error(`TBA team discovery page ${page} returned an invalid team directory`);
        }
        await this.env.DISCOVERY_BUCKET.put(
          `discovery/team-pages/${currentSeason.year}/${teamDirectoryGeneration}/${page}.json`,
          JSON.stringify(teams),
          { httpMetadata: { contentType: "application/json" } },
        );
        return {
          page,
          count: teams.length,
          hasMore: teams.length === teamPageSize,
          teamKeys: teams.map((team) => team.key as string),
        };
      });
      teamPageCount += 1;
      teamCount += pageResult.count;
      discoveredTeamKeys.push(...pageResult.teamKeys);
      if (!pageResult.hasMore) break;
    }
    const uniqueCurrentSeasonTeamKeys = [...new Set(discoveredTeamKeys)].sort();
    teamCount = uniqueCurrentSeasonTeamKeys.length;
    await step.do("publish-current-season-team-directory", async () => {
      // Publish the registry first; the manifest is the final commit point.
      await this.env.DISCOVERY_BUCKET.put(
        `registry/teams/${currentSeason.year}.json`,
        JSON.stringify(uniqueCurrentSeasonTeamKeys),
        { httpMetadata: { contentType: "application/json" } },
      );
      await this.env.DISCOVERY_BUCKET.put(
        `discovery/teams/${currentSeason.year}.json`,
        JSON.stringify({
          year: currentSeason.year,
          generation: teamDirectoryGeneration,
          pageCount: teamPageCount,
          teamCount: uniqueCurrentSeasonTeamKeys.length,
          updatedAt: teamDirectoryGeneration,
          checkedAt: Date.now(),
        }),
        { httpMetadata: { contentType: "application/json" } },
      );
      return { year: currentSeason.year, pages: teamPageCount, teams: teamCount };
    });

    const discovery: Array<{ year: number; count: number; checkedAt: number; generation: number; chunkCount: number; needsChunking: boolean }> = [];
    const eventChunkSize = 25;
    for (const year of years) {
      const result = await step.do(`discover-event-directory-${year}`, {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
        const key = `discovery/events/${year}.json`;
        const previous = await readJson<DiscoveryDocument>(this.env.DISCOVERY_BUCKET, key);
        const headers = new Headers({ "X-TBA-Auth-Key": this.env.TBA_API_KEY });
        if (previous?.etag) headers.set("If-None-Match", previous.etag);
        const api = new TBAApiClient({ apiKey: this.env.TBA_API_KEY });
        const response = await api.request(TBA_ENDPOINTS.events(year), { headers });
        const checkedAt = Date.now();
        if (response.status === 304 && previous) {
          const chunkCount = previous.chunkCount ?? Math.ceil(previous.events.length / eventChunkSize);
          const refreshed = { ...previous, chunkCount, checkedAt };
          await this.env.DISCOVERY_BUCKET.put(
            `registry/events/${year}.json`,
            JSON.stringify(previous.events.map((item) => item.key)),
            { httpMetadata: { contentType: "application/json" } },
          );
          await this.env.DISCOVERY_BUCKET.put(key, JSON.stringify(refreshed), {
            httpMetadata: { contentType: "application/json" },
          });
          return { year, count: previous.events.length, checkedAt, generation: previous.updatedAt, chunkCount, needsChunking: false };
        }
        if (!response.ok) throw new Error(`TBA event discovery for ${year} returned HTTP ${response.status}`);
        const events = await response.json() as TbaEvent[];
        if (!Array.isArray(events) || events.some((item) => !item || typeof item.key !== "string")) {
          throw new Error(`TBA event discovery for ${year} returned an invalid event directory`);
        }
        const chunkCount = Math.ceil(events.length / eventChunkSize);
        const document: DiscoveryDocument = {
          year, events, chunkCount, etag: response.headers.get("ETag"), updatedAt: checkedAt, checkedAt,
        };
        await this.env.DISCOVERY_BUCKET.put(
          `discovery/staging/${year}/${checkedAt}.json`,
          JSON.stringify(document),
          { httpMetadata: { contentType: "application/json" } },
        );
        await this.env.DISCOVERY_BUCKET.put(
          `discovery/staging/${year}/${checkedAt}-keys.json`,
          JSON.stringify(events.map((item) => item.key)),
          { httpMetadata: { contentType: "application/json" } },
        );
        return { year, count: events.length, checkedAt, generation: checkedAt, chunkCount, needsChunking: true };
      });
      discovery.push(result);
    }

    const chunkWriteBatchSize = 10;
    for (const directory of discovery) {
      if (directory.needsChunking) {
        for (let firstChunk = 0; firstChunk < directory.chunkCount; firstChunk += chunkWriteBatchSize) {
          const endChunk = Math.min(directory.chunkCount, firstChunk + chunkWriteBatchSize);
          await step.do(`write-event-chunks-${directory.year}-${firstChunk}`, async () => {
            const object = await this.env.DISCOVERY_BUCKET.get(
              `discovery/staging/${directory.year}/${directory.generation}.json`,
            );
            if (!object) throw new Error(`Missing staged event directory for ${directory.year}`);
            const document = await object.json<DiscoveryDocument>();
            for (let chunkIndex = firstChunk; chunkIndex < endChunk; chunkIndex += 1) {
              await this.env.DISCOVERY_BUCKET.put(
                `discovery/event-chunks/${directory.year}/${directory.generation}/${chunkIndex}.json`,
                JSON.stringify(document.events.slice(chunkIndex * eventChunkSize, (chunkIndex + 1) * eventChunkSize)),
                { httpMetadata: { contentType: "application/json" } },
              );
            }
            return { year: directory.year, chunksWritten: endChunk - firstChunk };
          });
        }
      }
      await step.do(`publish-event-directory-${directory.year}`, async () => {
        if (!directory.needsChunking) return { year: directory.year, published: false };
        const stagedDocument = await this.env.DISCOVERY_BUCKET.get(
          `discovery/staging/${directory.year}/${directory.generation}.json`,
        );
        const stagedKeys = await this.env.DISCOVERY_BUCKET.get(
          `discovery/staging/${directory.year}/${directory.generation}-keys.json`,
        );
        if (!stagedDocument || !stagedKeys) throw new Error(`Incomplete staged event directory for ${directory.year}`);
        await this.env.DISCOVERY_BUCKET.put(
          `registry/events/${directory.year}.json`, await stagedKeys.text(),
          { httpMetadata: { contentType: "application/json" } },
        );
        // The directory document is the publication point; write it last.
        await this.env.DISCOVERY_BUCKET.put(
          `discovery/events/${directory.year}.json`, await stagedDocument.text(),
          { httpMetadata: { contentType: "application/json" } },
        );
        return { year: directory.year, published: true };
      });
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
          const object = await this.env.DISCOVERY_BUCKET.get(
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
        lifecycleRefs: yearLifecycleRefs,
      });
    }

    // Resolve event participants independently so one unavailable event does
    // not prevent unrelated events from seeding their TeamRuntime instances.
    const participantKeys = new Set<string>();
    const eventRefs = classified.flatMap(({ eventRefs: items }) => items);
    const participantFailures: Array<{ event_key: string; error: string }> = [];
    for (const item of eventRefs) {
      try {
        const result = await step.do(`discover-participants-${item.key}`, {
          retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
        }, async () => {
          const api = new TBAApiClient({ apiKey: this.env.TBA_API_KEY });
          const response = await api.request(TBA_ENDPOINTS.eventTeamsSimple(item.key));
          if (!response.ok) throw new Error(`TBA event team discovery for ${item.key} returned HTTP ${response.status}`);
          const teams = await response.json() as Array<{ key?: unknown }>;
          if (!Array.isArray(teams) || teams.some((team) =>
            !team || typeof team.key !== "string" || !/^frc[0-9]+$/.test(team.key))) {
            throw new Error(`TBA event team discovery for ${item.key} returned an invalid team list`);
          }
          return [...new Set(teams.map((team) => team.key as string))].sort();
        });
        result.forEach((teamKey) => participantKeys.add(teamKey));
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
            const response = await this.env.FIELDVIEW_RUNTIME.fetch(new Request(
              `https://fieldview-runtime/internal/teams/${teamKey}/seed?year=${currentSeason.year}`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${this.env.RUNTIME_ADMIN_TOKEN}` },
              },
            ));
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
            await this.env.DISCOVERY_BUCKET.put(`registry/runtime-teams/${teamKey}.json`, "{}", {
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
      await this.env.DISCOVERY_BUCKET.put(manifestKey, JSON.stringify(eventRefs), {
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
            await this.env.DISCOVERY_BUCKET.put(`registry/runtime-events/${eventKey}.json`, "{}", {
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
      await this.env.DISCOVERY_BUCKET.put(
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
      await this.env.DISCOVERY_BUCKET.put(
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
        const current = await readJson<AdminDiscoveryJobRecord>(this.env.DISCOVERY_BUCKET, jobKey);
        const next: AdminDiscoveryJobRecord = {
          year: season, mode: "year", workflow_id: jobId, status: "running", stage: "starting",
          events: 0, teams: 0, team_pages: 0, steps: 0, error: null,
          started_at: requestedAt, updated_at: Date.now(), ...(current ?? {}), ...patch,
          workflow_id: jobId, year: season, updated_at: Date.now(),
        };
        await this.env.DISCOVERY_BUCKET.put(jobKey, JSON.stringify(next), {
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
        const key = `discovery/events/${season}.json`;
        const previous = await readJson<DiscoveryDocument>(this.env.DISCOVERY_BUCKET, key);
        const headers = new Headers({ "X-TBA-Auth-Key": this.env.TBA_API_KEY });
        if (previous?.etag) headers.set("If-None-Match", previous.etag);
        const api = new TBAApiClient({ apiKey: this.env.TBA_API_KEY });
        const response = await api.request(TBA_ENDPOINTS.events(season), { headers });
        const checkedAt = Date.now();
        if (response.status === 304 && previous) {
          const refreshed = { ...previous, checkedAt };
          await this.env.DISCOVERY_BUCKET.put(`registry/events/${season}.json`,
            JSON.stringify(previous.events.map((item) => item.key)),
            { httpMetadata: { contentType: "application/json" } });
          await this.env.DISCOVERY_BUCKET.put(key, JSON.stringify(refreshed), {
            httpMetadata: { contentType: "application/json" },
          });
          return {
            count: previous.events.length,
            chunkCount: previous.chunkCount ?? Math.ceil(previous.events.length / eventChunkSize),
            generation: previous.updatedAt, needsChunking: false, checkedAt,
          };
        }
        if (!response.ok) throw new Error(`TBA event discovery for ${season} returned HTTP ${response.status}`);
        const events = await response.json() as TbaEvent[];
        if (!Array.isArray(events) || events.some((item) => !item || typeof item.key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.key))) {
          throw new Error(`TBA event discovery for ${season} returned an invalid event directory`);
        }
        const document: DiscoveryDocument = {
          year: season, events, chunkCount: Math.ceil(events.length / eventChunkSize),
          etag: response.headers.get("ETag"), updatedAt: checkedAt, checkedAt,
        };
        await this.env.DISCOVERY_BUCKET.put(`discovery/staging/${season}/${generation}.json`, JSON.stringify(document), {
          httpMetadata: { contentType: "application/json" },
        });
        await this.env.DISCOVERY_BUCKET.put(`discovery/staging/${season}/${generation}-keys.json`,
          JSON.stringify(events.map((item) => item.key)),
          { httpMetadata: { contentType: "application/json" } });
        return {
          count: events.length, chunkCount: document.chunkCount,
          generation: checkedAt, needsChunking: true, checkedAt,
        };
      });
      await updateJob("record-event-discovery-progress", {
        stage: "publishing_events", events: eventDirectory.count, steps: 2,
      });

      if (eventDirectory.needsChunking) {
        for (let firstChunk = 0; firstChunk < eventDirectory.chunkCount; firstChunk += 10) {
          const endChunk = Math.min(eventDirectory.chunkCount, firstChunk + 10);
          await step.do(`write-manual-event-chunks-${firstChunk}`, async () => {
            const object = await this.env.DISCOVERY_BUCKET.get(
              `discovery/staging/${season}/${eventDirectory.generation}.json`,
            );
            if (!object) throw new Error(`Missing staged event directory for ${season}`);
            const document = await object.json<DiscoveryDocument>();
            for (let index = firstChunk; index < endChunk; index += 1) {
              await this.env.DISCOVERY_BUCKET.put(
                `discovery/event-chunks/${season}/${eventDirectory.generation}/${index}.json`,
                JSON.stringify(document.events.slice(index * eventChunkSize, (index + 1) * eventChunkSize)),
                { httpMetadata: { contentType: "application/json" } },
              );
            }
            return { chunks_written: endChunk - firstChunk };
          });
        }
        await step.do("publish-manual-event-directory", async () => {
          const stagedDocument = await this.env.DISCOVERY_BUCKET.get(
            `discovery/staging/${season}/${eventDirectory.generation}.json`,
          );
          const stagedKeys = await this.env.DISCOVERY_BUCKET.get(
            `discovery/staging/${season}/${eventDirectory.generation}-keys.json`,
          );
          if (!stagedDocument || !stagedKeys) throw new Error("Manual event discovery staging is incomplete");
          await this.env.DISCOVERY_BUCKET.put(`registry/events/${season}.json`, await stagedKeys.text(), {
            httpMetadata: { contentType: "application/json" },
          });
          await this.env.DISCOVERY_BUCKET.put(`discovery/events/${season}.json`, await stagedDocument.text(), {
            httpMetadata: { contentType: "application/json" },
          });
          return { published: true };
        });
      }

      const teamGeneration = await step.do("allocate-manual-team-directory-generation", async () => Date.now());
      const pageSize = 500;
      const teamKeys: string[] = [];
      let teamPages = 0;
      for (let page = 0; page < 100; page += 1) {
        const result = await step.do(`discover-manual-team-page-${page}`, {
          retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
        }, async () => {
          const api = new TBAApiClient({ apiKey: this.env.TBA_API_KEY });
          const response = await api.request(TBA_ENDPOINTS.teamsByYearPage(season, page));
          if (!response.ok) throw new Error(`TBA team discovery page ${page} returned HTTP ${response.status}`);
          const teams = await response.json() as Array<{ key?: unknown }>;
          if (!Array.isArray(teams) || teams.length > pageSize || teams.some((team) =>
            !team || typeof team.key !== "string" || !/^frc[0-9]+$/.test(team.key))) {
            throw new Error(`TBA team discovery page ${page} returned an invalid team directory`);
          }
          await this.env.DISCOVERY_BUCKET.put(
            `discovery/team-pages/${season}/${teamGeneration}/${page}.json`,
            JSON.stringify(teams),
            { httpMetadata: { contentType: "application/json" } },
          );
          return { keys: teams.map((team) => team.key as string), count: teams.length, hasMore: teams.length === pageSize };
        });
        teamKeys.push(...result.keys);
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
        await this.env.DISCOVERY_BUCKET.put(`registry/teams/${season}.json`, JSON.stringify(uniqueTeamKeys), {
          httpMetadata: { contentType: "application/json" },
        });
        await this.env.DISCOVERY_BUCKET.put(`discovery/teams/${season}.json`, JSON.stringify({
          year: season, generation: teamGeneration, pageCount: teamPages,
          teamCount: uniqueTeamKeys.length, updatedAt: teamGeneration, checkedAt: Date.now(),
        }), { httpMetadata: { contentType: "application/json" } });
        return { published: true };
      });
      const summary = {
        year: season, mode: "year", workflow_id: jobId, status: "completed", stage: "complete",
        events: eventDirectory.count, teams: uniqueTeamKeys.length, team_pages: teamPages,
        steps: 4 + teamPages + (eventDirectory.needsChunking ? Math.ceil(eventDirectory.chunkCount / 10) + 1 : 0),
        error: null, started_at: requestedAt, updated_at: Date.now(),
      };
      await step.do("publish-manual-discovery-summary", async () => {
        await this.env.DISCOVERY_BUCKET.put(jobKey, JSON.stringify(summary), {
          httpMetadata: { contentType: "application/json" },
        });
        return summary;
      });
      return summary;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await step.do("record-manual-discovery-failure", async () => {
        const current = await readJson<AdminDiscoveryJobRecord>(this.env.DISCOVERY_BUCKET, jobKey);
        const failed: AdminDiscoveryJobRecord = {
          year: season, mode: "year", workflow_id: jobId, status: "failed", stage: current?.stage ?? "failed",
          events: current?.events ?? 0, teams: current?.teams ?? 0, team_pages: current?.team_pages ?? 0,
          steps: current?.steps ?? 0, error: detail.slice(0, 500),
          started_at: requestedAt, updated_at: Date.now(),
        };
        await this.env.DISCOVERY_BUCKET.put(jobKey, JSON.stringify(failed), {
          httpMetadata: { contentType: "application/json" },
        });
        return failed;
      });
      throw error;
    }
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
        const directory = await readPublishedSeason(this.env.DISCOVERY_BUCKET, year);
        if (!directory) throw new Error("Complete R2 event and paginated team discovery is required before starting the coverage audit");
        const now = Date.now();
        const runtimeEvents = new Set(await listRuntimeRegistry(this.env.DISCOVERY_BUCKET, "event"));
        const runtimeTeams = new Set(await listRuntimeRegistry(this.env.DISCOVERY_BUCKET, "team"));
        const items: CoverageAuditItem[] = [
          ...directory.events
            .filter((item) => typeof item.key === "string" && /^[a-zA-Z0-9_-]+$/.test(item.key))
            .map((item) => ({ kind: "event" as const, key: item.key, registered: runtimeEvents.has(item.key) })),
          ...directory.teamKeys.map((key) => ({ kind: "team" as const, key, registered: runtimeTeams.has(key) })),
        ];
        if (items.length > 14_000) {
          throw new Error("Coverage audit exceeds the 14,000-entity Free-plan step budget; split the audit into smaller scopes");
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
          const lifecycle = lifecycleFor(item, now).lifecycle;
          if (lifecycle === "completed" || lifecycle === "expired") counts.events_happened += 1;
          else if (lifecycle === "active") counts.events_active += 1;
          else if (lifecycle === "upcoming") counts.events_upcoming += 1;
          else counts.events_invalid_dates += 1;
        }
        const allItemsKey = itemsPrefix + "all.json";
        await this.env.DISCOVERY_BUCKET.put(allItemsKey, JSON.stringify(items), {
          httpMetadata: { contentType: "application/json" },
        });
        const record: CoverageAuditRecord = {
          year, workflow_id: workflowId, status: "running", started_at: startedAt, updated_at: now,
          cursor: 0, total: items.length, event_discovery_updated_at: directory.eventUpdatedAt,
          team_discovery_updated_at: directory.teamUpdatedAt, items_prefix: itemsPrefix, counts, error: null,
        };
        await this.env.DISCOVERY_BUCKET.put(auditKey, JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
        });
        return { total: items.length, chunkCount: Math.ceil(items.length / 100), counts, itemsPrefix, record };
      });

      for (let firstChunk = 0; firstChunk < prepared.chunkCount; firstChunk += 10) {
        const endChunk = Math.min(prepared.chunkCount, firstChunk + 10);
        await step.do(`write-coverage-audit-items-${firstChunk}`, async () => {
          const allItems = await readJson<CoverageAuditItem[]>(this.env.DISCOVERY_BUCKET, prepared.itemsPrefix + "all.json");
          if (!allItems || allItems.length !== prepared.total) throw new Error("Coverage audit item manifest is missing or incomplete");
          for (let chunk = firstChunk; chunk < endChunk; chunk += 1) {
            await this.env.DISCOVERY_BUCKET.put(
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
          const chunk = await readJson<CoverageAuditItem[]>(this.env.DISCOVERY_BUCKET, prepared.itemsPrefix + `${chunkIndex}.json`);
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
              const response = await this.env.FIELDVIEW_RUNTIME.fetch(new Request(
                `https://fieldview-runtime/internal/workflows/runtime-state?kind=${item.kind}&key=${encodeURIComponent(item.key)}`,
                { headers: { Authorization: `Bearer ${this.env.RUNTIME_ADMIN_TOKEN}` } },
              ));
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
          await this.env.DISCOVERY_BUCKET.put(auditKey, JSON.stringify(record), {
            httpMetadata: { contentType: "application/json" },
          });
          return { cursor: nextCursor, counts: nextCounts };
        });
        cursor = batchResult.cursor;
        counts = batchResult.counts;
      }

      const completed = await step.do("complete-coverage-audit", async () => {
        const current = await readPublishedSeason(this.env.DISCOVERY_BUCKET, year);
        const stale = !current ||
          current.eventUpdatedAt !== prepared.record.event_discovery_updated_at ||
          current.teamUpdatedAt !== prepared.record.team_discovery_updated_at;
        const record: CoverageAuditRecord = {
          ...prepared.record, cursor, counts, status: stale ? "stale" : "completed",
          updated_at: Date.now(), error: null,
        };
        await this.env.DISCOVERY_BUCKET.put(auditKey, JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
        });
        return record;
      });
      return completed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await step.do("record-coverage-audit-failure", async () => {
        const current = await readJson<CoverageAuditRecord>(this.env.DISCOVERY_BUCKET, auditKey);
        if (current) await this.env.DISCOVERY_BUCKET.put(auditKey, JSON.stringify({
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
    if (url.pathname === "/internal/admin/coverage-audit" && request.method === "GET") {
      if (!env.RUNTIME_ADMIN_TOKEN ||
          request.headers.get("Authorization") !== `Bearer ${env.RUNTIME_ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const year = Number(url.searchParams.get("year"));
      if (!Number.isInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid audit year" }, { status: 400 });
      }
      const record = await readJson<CoverageAuditRecord>(env.DISCOVERY_BUCKET, `admin/coverage-audits/${year}.json`);
      const discoveryReady = (await readPublishedSeason(env.DISCOVERY_BUCKET, year)) !== null;
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
      let current = await readJson<CoverageAuditRecord>(env.DISCOVERY_BUCKET, key);
      if (action === "start") {
        const directory = await readPublishedSeason(env.DISCOVERY_BUCKET, year);
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
          await env.DISCOVERY_BUCKET.put(
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
        await env.DISCOVERY_BUCKET.put(key, JSON.stringify(current), {
          httpMetadata: { contentType: "application/json" },
        });
        try {
          await env.COVERAGE_AUDIT.create({
            id: workflowId, params: { year, workflowId, startedAt },
          });
        } catch (error) {
          const failed = { ...current, status: "failed" as const,
            error: error instanceof Error ? error.message : String(error), updated_at: Date.now() };
          await env.DISCOVERY_BUCKET.put(key, JSON.stringify(failed), {
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
      const job = await readJson<AdminDiscoveryJobRecord>(env.DISCOVERY_BUCKET, `admin/discovery-jobs/${year}.json`);
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
      const current = await readJson<AdminDiscoveryJobRecord>(env.DISCOVERY_BUCKET, key);
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
      await env.DISCOVERY_BUCKET.put(key, JSON.stringify(job), {
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
        await env.DISCOVERY_BUCKET.put(key, JSON.stringify(failed), {
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
