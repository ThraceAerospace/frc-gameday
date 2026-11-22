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
    await step.do("publish-current-season-team-directory", async () => {
      await this.env.DISCOVERY_BUCKET.put(
        `discovery/teams/${currentSeason.year}.json`,
        JSON.stringify({
          year: currentSeason.year,
          generation: teamDirectoryGeneration,
          pageCount: teamPageCount,
          teamCount,
          updatedAt: teamDirectoryGeneration,
          checkedAt: Date.now(),
        }),
        { httpMetadata: { contentType: "application/json" } },
      );
      await this.env.DISCOVERY_BUCKET.put(
        `registry/teams/${currentSeason.year}.json`,
        JSON.stringify([...new Set(discoveredTeamKeys)].sort()),
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
          await this.env.DISCOVERY_BUCKET.put(key, JSON.stringify(refreshed), {
            httpMetadata: { contentType: "application/json" },
          });
          await this.env.DISCOVERY_BUCKET.put(
            `registry/events/${year}.json`,
            JSON.stringify(previous.events.map((item) => item.key)),
            { httpMetadata: { contentType: "application/json" } },
          );
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
          `discovery/events/${directory.year}.json`, await stagedDocument.text(),
          { httpMetadata: { contentType: "application/json" } },
        );
        await this.env.DISCOVERY_BUCKET.put(
          `registry/events/${directory.year}.json`, await stagedKeys.text(),
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
          return { seeded, failed };
        });
        seededTeams.push(...result.seeded);
        failedTeams.push(...result.failed);
      } catch (error) {
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
        return { initialized: batchInitialized, failures: batchFailures };
      });
      initialized.push(...result.initialized);
      failures.push(...result.failures);
    }

    await step.do("publish-runtime-event-registry", async () => {
      const existing = await readJson<string[]>(this.env.DISCOVERY_BUCKET, "registry/runtime-events.json") ?? [];
      const next = [...new Set([...existing, ...initialized])].sort();
      await this.env.DISCOVERY_BUCKET.put("registry/runtime-events.json", JSON.stringify(next), {
        httpMetadata: { contentType: "application/json" },
      });
      return { registered: initialized.length, total: next.length };
    });

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
