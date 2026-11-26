import type { RuntimeEnvironment } from "./cloudflare.ts";
import { D1RecordStore, type D1RecordStorage } from "./d1-record-store.ts";
import { TBAApiClient } from "../../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../../packages/providers/tba/src/endpoints.ts";
const MAX_LIST_LIMIT = 1000;

/** System-wide TBA discovery and catalog owner; entity-scoped canonical state remains runtime-owned. */
export class DiscoveryService {
  private readonly storage: D1RecordStorage;
  private readonly api: TBAApiClient | null;
  constructor(db: D1Database | D1RecordStorage, env?: RuntimeEnvironment) {
    this.storage = "prepare" in db ? new D1RecordStore(db) : db;
    this.api = env?.TBA_API_KEY
      ? new TBAApiClient({ apiKey: env.TBA_API_KEY, ...(env.fetcher ? { fetch: env.fetcher } : {}) })
      : null;
  }

  private async deleteKey(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const entries = await this.storage.list<string>({
        prefix: prefix,
        ...(cursor ? { startAfter: cursor } : {}),
        limit: 1000,
      });
      const keys = [...entries.keys()];
      if (!keys.length) return;
      await Promise.all(keys.map((key) => this.storage.delete(key)));
      if (keys.length < 1000) return;
      cursor = keys[keys.length - 1];
    }
  }

  private async pruneSupersededRecord(key: string, previous: string | undefined, next: string): Promise<void> {
    if (!previous) return;
    try {
      const oldValue = JSON.parse(previous) as Record<string, unknown>;
      const newValue = JSON.parse(next) as Record<string, unknown>;
      const teamManifest = key.match(/^discovery\/teams\/(\d{4})\.json$/);
      if (teamManifest && typeof oldValue.generation === "number" && oldValue.generation !== newValue.generation) {
        await this.deletePrefix(`discovery/team-pages/${teamManifest[1]}/${oldValue.generation}/`);
      }
      const eventDirectory = key.match(/^discovery\/events\/(\d{4})\.json$/);
      if (eventDirectory && typeof oldValue.updatedAt === "number" && oldValue.updatedAt !== newValue.updatedAt) {
        await this.deletePrefix(`discovery/event-chunks/${eventDirectory[1]}/${oldValue.updatedAt}/`);
        await this.deleteKey(`discovery/staging/${eventDirectory[1]}/${oldValue.updatedAt}.json`);
        await this.deleteKey(`discovery/staging/${eventDirectory[1]}/${oldValue.updatedAt}-keys.json`);
      }
      const coverageAudit = key.match(/^admin\/coverage-audits\/(\d{4})\.json$/);
      if (coverageAudit && typeof oldValue.items_prefix === "string" && oldValue.items_prefix !== newValue.items_prefix) {
        await this.deletePrefix(oldValue.items_prefix);
      }
    } catch {
      // A malformed prior record must not prevent publishing its replacement.
    }
  }
  private async putValue(key: string, value: string): Promise<void> {
    const previous = await this.storage.get<string>(key);
    await this.storage.put(key, value);
    await this.pruneSupersededRecord(key, previous, value);
  }

  private requireApi(): TBAApiClient {
    if (!this.api) throw new Error("TBA provider is not configured");
    return this.api;
  }

  private async resolveCurrentSeason(): Promise<Response> {
    const key = "discovery/current-season.json";
    const knownRaw = await this.storage.get<string>(key);
    let known: { year?: unknown; maxTeamPage?: unknown; checkedAt?: unknown } | null = null;
    try { known = knownRaw ? JSON.parse(knownRaw) as { year?: unknown; maxTeamPage?: unknown; checkedAt?: unknown } : null; } catch { known = null; }
    try {
      const response = await this.requireApi().request(TBA_ENDPOINTS.status());
      if (!response.ok) throw new Error("TBA status returned HTTP " + response.status);
      const status = await response.json() as { current_season?: unknown; max_team_page?: unknown };
      const raw = status?.current_season;
      const year = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (!Number.isInteger(year) || year < 1992 || year > 2200) throw new Error("TBA status returned an invalid current_season");
      const rawMaxTeamPage = status?.max_team_page;
      const maxTeamPage = typeof rawMaxTeamPage === "number" ? rawMaxTeamPage
        : typeof rawMaxTeamPage === "string" ? Number(rawMaxTeamPage) : NaN;
      const resolved = {
        year,
        ...(Number.isInteger(maxTeamPage) && maxTeamPage >= 0 ? { maxTeamPage } : {}),
        checkedAt: Date.now(),
      };
      await this.putValue(key, JSON.stringify(resolved));
      return Response.json(resolved);
    } catch (error) {
      if (known && Number.isInteger(known.year) && Number(known.year) >= 1992 && Number(known.year) <= 2200) {
        return Response.json({ ...known, fallback: true });
      }
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
    }
  }

  private async discoverTeamPage(input: Record<string, unknown>): Promise<Response> {
    const year = Number(input.year), generation = Number(input.generation), page = Number(input.page);
    if (!Number.isInteger(year) || year < 1992 || year > 2200 ||
        !Number.isSafeInteger(generation) || generation < 0 ||
        !Number.isInteger(page) || page < 0) {
      return Response.json({ error: "Invalid team directory page request" }, { status: 400 });
    }
    const response = await this.requireApi().request(TBA_ENDPOINTS.teamsByYearPageKeys(year, page));
    if (!response.ok) return Response.json({ error: "TBA team discovery page returned HTTP " + response.status }, { status: response.status });
    const teamKeys = await response.json() as unknown;
    if (!Array.isArray(teamKeys) || teamKeys.some((key) =>
      typeof key !== "string" || !/^frc[0-9]+$/.test(key))) {
      return Response.json({ error: "TBA returned an invalid team directory page" }, { status: 502 });
    }
    await this.putValue(
      `discovery/team-pages/${year}/${generation}/${page}.json`,
      JSON.stringify(teamKeys),
    );
    return Response.json({ page, count: teamKeys.length, teamKeys });
  }

  private async resumePartialTeamDirectory(input: Record<string, unknown>): Promise<Response> {
    const year = Number(input.year), expectedPageCount = Number(input.expectedPageCount);
    if (!Number.isInteger(year) || year < 1992 || year > 2200 ||
        !Number.isInteger(expectedPageCount) || expectedPageCount < 1) {
      return Response.json({ error: "Invalid partial team directory lookup" }, { status: 400 });
    }
    const prefix = `discovery/partial-teams/${year}/`;
    const entries = await this.storage.list<string>({ prefix });
    const candidates = [...entries.entries()]
      .map(([key, value]) => ({ key, value, generation: Number(key.slice(prefix.length, -5)) }))
      .filter((item) => item.key.endsWith(".json") && Number.isSafeInteger(item.generation) && item.generation >= 0)
      .sort((a, b) => b.generation - a.generation);
    for (const candidate of candidates) {
      try {
        const partial = JSON.parse(candidate.value) as {
          expectedPageCount?: unknown; failedPages?: unknown; teamKeys?: unknown; complete?: unknown; warnings?: unknown;
        };
        if (partial.complete !== false || partial.expectedPageCount !== expectedPageCount ||
            !Array.isArray(partial.failedPages) || !Array.isArray(partial.teamKeys)) continue;
        const failedPages = partial.failedPages as number[];
        const teamKeys = partial.teamKeys as string[];
        if (failedPages.some((page) => !Number.isInteger(page) || page < 0 || page >= expectedPageCount) ||
            teamKeys.some((key) => typeof key !== "string" || !/^frc[0-9]+$/.test(key))) continue;
        let pagesValid = true;
        for (let page = 0; page < expectedPageCount; page += 1) {
          if (failedPages.includes(page)) continue;
          const stored = await this.storage.get<string>(`discovery/team-pages/${year}/${candidate.generation}/${page}.json`);
          if (!stored) { pagesValid = false; break; }
        }
        if (!pagesValid) continue;
        return Response.json({
          resumable: true, generation: candidate.generation,
          teamKeys, failedPages: [...new Set(failedPages)].sort((a, b) => a - b),
          warnings: Array.isArray(partial.warnings) ? partial.warnings : [],
        });
      } catch { /* Ignore malformed partial records and inspect the next candidate. */ }
    }
    return Response.json({ resumable: false });
  }

  private async publishTeamDirectory(input: Record<string, unknown>): Promise<Response> {
    const year = Number(input.year), generation = Number(input.generation), pageCount = Number(input.pageCount);
    const teamKeys = input.teamKeys;
    const rawFailedPages = input.failedPages ?? [];
    const rawWarnings = input.warnings ?? [];
    if (!Number.isInteger(year) || year < 1992 || year > 2200 ||
        !Number.isSafeInteger(generation) || generation < 0 ||
        !Number.isInteger(pageCount) || pageCount < 1 ||
        !Array.isArray(teamKeys) ||
        teamKeys.some((key) => typeof key !== "string" || !/^frc[0-9]+$/.test(key)) ||
        !Array.isArray(rawFailedPages) || rawFailedPages.some((page) =>
          !Number.isInteger(page) || Number(page) < 0 || Number(page) >= pageCount) ||
        !Array.isArray(rawWarnings) || rawWarnings.some((warning) => typeof warning !== "string")) {
      return Response.json({ error: "Invalid team directory publication" }, { status: 400 });
    }
    const warnings = (rawWarnings as string[]).slice(0, 200);
    const failedPages = [...new Set(rawFailedPages as number[])].sort((a, b) => a - b);
    const failedPageSet = new Set(failedPages);
    const unique = [...new Set(teamKeys as string[])].sort();
    const observed = new Set<string>();
    for (let page = 0; page < pageCount; page += 1) {
      const raw = await this.storage.get<string>(`discovery/team-pages/${year}/${generation}/${page}.json`);
      if (failedPageSet.has(page)) {
        if (raw !== undefined) return Response.json({ error: `Failed team page ${page} unexpectedly has a successful result` }, { status: 409 });
        continue;
      }
      if (!raw) return Response.json({ error: `Team directory page ${page} is missing and was not recorded as failed` }, { status: 409 });
      let pageKeys: unknown;
      try { pageKeys = JSON.parse(raw) as unknown; } catch {
        return Response.json({ error: `Team directory page ${page} is invalid JSON` }, { status: 409 });
      }
      if (!Array.isArray(pageKeys) || pageKeys.some((key) => typeof key !== "string" || !/^frc[0-9]+$/.test(key))) {
        return Response.json({ error: `Team directory page ${page} is invalid` }, { status: 409 });
      }
      for (const key of pageKeys) observed.add(key as string);
    }
    const observedKeys = [...observed].sort();
    if (observedKeys.length !== unique.length || observedKeys.some((key, index) => key !== unique[index])) {
      return Response.json({ error: "Team directory page contents do not match the publication manifest" }, { status: 409 });
    }
    if (failedPages.length) {
      const partial = {
        year, generation, status: "partial", complete: false, expectedPageCount: pageCount,
        successfulPageCount: pageCount - failedPages.length, failedPages, warnings,
        teamCount: unique.length, teamKeys: unique, updatedAt: generation, checkedAt: Date.now(),
      };
      await this.putValue(`discovery/partial-teams/${year}/${generation}.json`, JSON.stringify(partial));
      return Response.json({
        year, status: "partial", complete: false, pages: pageCount - failedPages.length,
        expectedPages: pageCount, failedPages, teams: unique.length,
      });
    }
    if (!unique.length) return Response.json({ error: "TBA returned an empty team directory" }, { status: 502 });
    await this.putValue(`registry/teams/${year}.json`, JSON.stringify(unique));
    await this.putValue(`discovery/teams/${year}.json`, JSON.stringify({
      year, generation, pageCount, expectedPageCount: pageCount, successfulPageCount: pageCount,
      failedPages: [], status: "completed", complete: true,
      teamCount: unique.length, updatedAt: generation, checkedAt: Date.now(),
    }));
    await this.deleteKey(`discovery/partial-teams/${year}/${generation}.json`);
    return Response.json({ year, status: "completed", complete: true, pages: pageCount, teams: unique.length });
  }

  private async discoverEventDirectory(input: Record<string, unknown>): Promise<Response> {
    const year = Number(input.year);
    const suppliedGeneration = input.generation === undefined ? undefined : Number(input.generation);
    const chunkSize = Number(input.chunkSize ?? 25);
    if (!Number.isInteger(year) || year < 1992 || year > 2200 ||
        (suppliedGeneration !== undefined && (!Number.isSafeInteger(suppliedGeneration) || suppliedGeneration < 0)) ||
        !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 100) {
      return Response.json({ error: "Invalid event directory discovery request" }, { status: 400 });
    }
    const key = `discovery/events/${year}.json`;
    const previousRaw = await this.storage.get<string>(key);
    let previous: { events?: Array<{ key: string }>; chunkCount?: number; etag?: string | null; updatedAt?: number } | null = null;
    try { previous = previousRaw ? JSON.parse(previousRaw) : null; } catch { previous = null; }
    const headers = new Headers();
    if (previous?.etag) headers.set("If-None-Match", previous.etag);
    const response = await this.requireApi().request(TBA_ENDPOINTS.events(year), { headers });
    const checkedAt = Date.now();
    if (response.status === 304 && previous && Array.isArray(previous.events)) {
      const chunkCount = previous.chunkCount ?? Math.ceil(previous.events.length / chunkSize);
      const refreshed = { ...previous, chunkCount, checkedAt };
      await this.putValue(`registry/events/${year}.json`, JSON.stringify(previous.events.map((item) => item.key)));
      await this.putValue(key, JSON.stringify(refreshed));
      return Response.json({
        year, count: previous.events.length, checkedAt,
        generation: previous.updatedAt, chunkCount, needsChunking: false,
      });
    }
    if (!response.ok) return Response.json({ error: "TBA event discovery returned HTTP " + response.status }, { status: response.status });
    const events = await response.json() as Array<{ key?: unknown }>;
    if (!Array.isArray(events) || events.some((item) =>
      !item || typeof item.key !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.key))) {
      return Response.json({ error: "TBA returned an invalid event directory" }, { status: 502 });
    }
    const generation = suppliedGeneration ?? checkedAt;
    const chunkCount = Math.ceil(events.length / chunkSize);
    const document = { year, events, chunkCount, chunkSize, etag: response.headers.get("ETag"), updatedAt: generation, checkedAt };
    await this.putValue(`discovery/staging/${year}/${generation}.json`, JSON.stringify(document));
    await this.putValue(`discovery/staging/${year}/${generation}-keys.json`, JSON.stringify(events.map((item) => item.key)));
    return Response.json({ year, count: events.length, checkedAt, generation, chunkCount, needsChunking: true });
  }

  private async writeEventChunks(input: Record<string, unknown>): Promise<Response> {
    const year = Number(input.year), generation = Number(input.generation);
    const firstChunk = Number(input.firstChunk), endChunk = Number(input.endChunk), chunkSize = Number(input.chunkSize ?? 25);
    if (!Number.isInteger(year) || year < 1992 || year > 2200 ||
        !Number.isSafeInteger(generation) || generation < 0 ||
        !Number.isSafeInteger(firstChunk) || firstChunk < 0 ||
        !Number.isSafeInteger(endChunk) || endChunk < firstChunk ||
        !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 100) {
      return Response.json({ error: "Invalid event chunk write request" }, { status: 400 });
    }
    const raw = await this.storage.get<string>(`discovery/staging/${year}/${generation}.json`);
    if (!raw) return Response.json({ error: "Staged event directory is missing" }, { status: 404 });
    const document = JSON.parse(raw) as { events?: unknown[]; chunkCount?: number; chunkSize?: number };
    if (!Array.isArray(document.events) || !Number.isInteger(document.chunkCount) ||
        document.chunkSize !== chunkSize || endChunk > Number(document.chunkCount)) {
      return Response.json({ error: "Staged event directory is invalid" }, { status: 409 });
    }
    for (let index = firstChunk; index < endChunk; index += 1) {
      await this.putValue(
        `discovery/event-chunks/${year}/${generation}/${index}.json`,
        JSON.stringify(document.events.slice(index * chunkSize, (index + 1) * chunkSize)),
      );
    }
    return Response.json({ year, chunksWritten: endChunk - firstChunk });
  }

  private async publishEventDirectory(input: Record<string, unknown>): Promise<Response> {
    const year = Number(input.year), generation = Number(input.generation);
    if (!Number.isInteger(year) || year < 1992 || year > 2200 || !Number.isSafeInteger(generation) || generation < 0) {
      return Response.json({ error: "Invalid event directory publication" }, { status: 400 });
    }
    const stagedDocument = await this.storage.get<string>(`discovery/staging/${year}/${generation}.json`);
    const stagedKeys = await this.storage.get<string>(`discovery/staging/${year}/${generation}-keys.json`);
    if (!stagedDocument || !stagedKeys) return Response.json({ error: "Event discovery staging is incomplete" }, { status: 409 });
    let document: { events?: Array<{ key?: unknown }>; chunkCount?: number; chunkSize?: number };
    let keys: unknown;
    try {
      document = JSON.parse(stagedDocument);
      keys = JSON.parse(stagedKeys);
    } catch {
      return Response.json({ error: "Event discovery staging is invalid JSON" }, { status: 409 });
    }
    if (!Array.isArray(document.events) || !Number.isSafeInteger(document.chunkCount) ||
        !Number.isSafeInteger(document.chunkSize) || Number(document.chunkSize) < 1 ||
        Number(document.chunkCount) !== Math.ceil(document.events.length / Number(document.chunkSize)) ||
        !Array.isArray(keys) || keys.length !== document.events.length ||
        document.events.some((item, index) => !item || typeof item.key !== "string" || keys[index] !== item.key)) {
      return Response.json({ error: "Event discovery staging manifest is invalid" }, { status: 409 });
    }
    for (let index = 0; index < Number(document.chunkCount); index += 1) {
      const chunk = await this.storage.get<string>(`discovery/event-chunks/${year}/${generation}/${index}.json`);
      if (!chunk) return Response.json({ error: `Event discovery chunk ${index} is missing` }, { status: 409 });
      try {
        const parsed = JSON.parse(chunk);
        const expected = document.events.slice(index * Number(document.chunkSize), (index + 1) * Number(document.chunkSize));
        if (!Array.isArray(parsed) || JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("chunk mismatch");
      } catch {
        return Response.json({ error: `Event discovery chunk ${index} is invalid` }, { status: 409 });
      }
    }
    await this.putValue(`registry/events/${year}.json`, stagedKeys);
    await this.putValue(`discovery/events/${year}.json`, stagedDocument);
    return Response.json({ year, published: true });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.startsWith("/catalog/")) {
      const input: unknown = await request.json().catch(() => null);
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return Response.json({ error: "Invalid catalog operation payload" }, { status: 400 });
      }
      const body = input as Record<string, unknown>;
      const action = url.pathname.slice("/catalog/".length);
      if (action === "resolve-current-season") return this.resolveCurrentSeason();
      if (action === "discover-team-page") return this.discoverTeamPage(body);
      if (action === "resume-partial-team-directory") return this.resumePartialTeamDirectory(body);
      if (action === "publish-team-directory") return this.publishTeamDirectory(body);
      if (action === "discover-event-directory") return this.discoverEventDirectory(body);
      if (action === "write-event-chunks") return this.writeEventChunks(body);
      if (action === "publish-event-directory") return this.publishEventDirectory(body);
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (request.method === "GET" && url.pathname === "/get") {
      const key = url.searchParams.get("key");
      if (!key || key.length > 1024) return Response.json({ error: "Invalid key" }, { status: 400 });
      const value = await this.storage.get<string>(key);
      return value === undefined ? new Response(null, { status: 404 }) : new Response(value, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (request.method === "POST" && url.pathname === "/put") {
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid write" }, { status: 400 });
      const input = body as Record<string, unknown>;
      if (typeof input.key !== "string" || !input.key.length || input.key.length > 1024 || typeof input.value !== "string") {
        return Response.json({ error: "Expected a key and string value" }, { status: 400 });
      }
      if (new TextEncoder().encode(input.value).byteLength > 7_000_000) {
        return Response.json({ error: "Catalog record exceeds the 7 MB safety limit" }, { status: 413 });
      }
      const previous = await this.storage.get<string>(input.key);
      await this.storage.put(input.key, input.value);
      await this.pruneSupersededRecord(input.key, previous, input.value);
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const cursor = url.searchParams.get("cursor") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      if (prefix.length > 1024 || cursor.length > 1100 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        return Response.json({ error: "Invalid list query" }, { status: 400 });
      }
      const entries = await this.storage.list<string>({
        prefix: prefix, ...(cursor ? { startAfter: cursor } : {}), limit: limit + 1,
      });
      const keys = [...entries.keys()].filter((key) => key.startsWith(prefix));
      const truncated = keys.length > limit;
      const page = keys.slice(0, limit);
      return Response.json({ objects: page.map((key) => ({ key })), truncated,
        ...(truncated && page.length ? { cursor: page[page.length - 1] } : {}) });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
