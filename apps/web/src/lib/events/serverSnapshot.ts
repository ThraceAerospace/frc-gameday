import type { FieldViewEvent, FieldViewEventState, FieldViewTeam, FieldViewTeamState } from "@fieldview/domain";

type RuntimeFetchInit = RequestInit & {
  next?: { revalidate?: number; tags?: string[] };
};

async function fetchCanonicalRuntime(
  operation: string,
  url: URL,
  fetcher: typeof fetch,
  init: RuntimeFetchInit = { cache: "no-store" },
): Promise<Response> {
  const startedAt = performance.now();
  try {
    const response = await fetcher(url, init);
    console.info("[FV][NextRuntimeFetch]", JSON.stringify({
      operation,
      status: response.status,
      headers_duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
    }));
    return response;
  } catch (error) {
    console.error("[FV][NextRuntimeFetch]", JSON.stringify({
      operation,
      outcome: "error",
      total_duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
}

async function readCanonicalJson<T>(operation: string, response: Response): Promise<T> {
  const startedAt = performance.now();
  try {
    return await response.json() as T;
  } finally {
    console.info("[FV][NextRuntimeBody]", JSON.stringify({
      operation,
      body_parse_duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
    }));
  }
}

export type CanonicalCurrentSeasonResponse = {
  year: number;
  checkedAt: number;
};

/** Read the persisted TBA status current_season value; never infer it from the clock. */
export async function getCanonicalCurrentSeason(
  fetcher: typeof fetch = fetch,
): Promise<CanonicalCurrentSeasonResponse | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl) return null;
  try {
    const url = new URL("/season/current", baseUrl);
    const response = await fetchCanonicalRuntime("current-season", url, fetcher, { cache: "no-store" });
    if (!response.ok) return null;
    const value = await readCanonicalJson<CanonicalCurrentSeasonResponse>("current-season", response);
    if (!Number.isInteger(value.year) || value.year < 1992 || value.year > 2200 ||
        !Number.isFinite(value.checkedAt)) return null;
    return value;
  } catch {
    return null;
  }
}

export type CanonicalEventSnapshotResponse = {
  version: number;
  snapshot: FieldViewEventState;
};

/**
 * Read the canonical event snapshot when a server-side runtime origin is
 * configured. A null result means the canonical Worker snapshot is unavailable.
 */
export async function getCanonicalEventSnapshot(
  eventKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CanonicalEventSnapshotResponse | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl || !eventKey) return null;

  try {
    const url = new URL(`/events/${encodeURIComponent(eventKey)}/snapshot`, baseUrl);
    const response = await fetchCanonicalRuntime("event-snapshot", url, fetcher);
    if (!response.ok) return null;

    const version = Number(response.headers.get("X-FieldView-Snapshot-Version"));
    if (!Number.isSafeInteger(version) || version < 0) return null;

    const snapshot = await readCanonicalJson<FieldViewEventState>("event-snapshot", response);
    if (snapshot.event_key !== eventKey) return null;
    return { version, snapshot };
  } catch {
    return null;
  }
}

export type CanonicalEventAnalyticsResponse = {
  event_key: string;
  revision: number;
  status: "pending" | "running" | "succeeded" | "failed" | string;
  due_at: number | null;
  calculated_at: number | null;
  source_revision: number | null;
  publication: unknown | null;
};

/** Read the last durable EventRuntime analytics publication without triggering calculations. */
export async function getCanonicalEventAnalytics(
  eventKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CanonicalEventAnalyticsResponse | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl || !eventKey) return null;
  try {
    const url = new URL("/events/" + encodeURIComponent(eventKey) + "/analytics", baseUrl);
    const response = await fetchCanonicalRuntime("event-analytics", url, fetcher);
    if (!response.ok) return null;
    const value = await readCanonicalJson<CanonicalEventAnalyticsResponse>("event-analytics", response);
    if (value.event_key !== eventKey || !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
    return value;
  } catch {
    return null;
  }
}

export type CanonicalEventWeekResponse = {
  runDate: string;
  evaluatedAt: number;
  events: FieldViewEvent[];
  pending?: boolean;
};

/** Read EventScheduler's precomputed weekly projection; never fan out to EventRuntime here. */
export async function getCanonicalEventThisWeek(
  fetcher: typeof fetch = fetch,
): Promise<CanonicalEventWeekResponse | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl) return null;
  try {
    const url = new URL("/events/this-week", baseUrl);
    const response = await fetchCanonicalRuntime("event-this-week", url, fetcher, {
      // Pending responses must never be cached as an empty weekly projection.
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = await readCanonicalJson<CanonicalEventWeekResponse>("event-this-week", response);
    if (typeof payload.runDate !== "string" || !Number.isFinite(payload.evaluatedAt) ||
        !Array.isArray(payload.events) ||
        !payload.events.every((event) => typeof event?.key === "string")) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getCanonicalEventDiscovery(
  year: number,
  fetcher: typeof fetch = fetch,
): Promise<FieldViewEvent[] | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl || !Number.isSafeInteger(year)) return null;

  try {
    const url = new URL(`/events/discovery?year=${year}`, baseUrl);
    // Event discovery is a large, slow-changing season directory. Cache it in
    // the Next.js Data Cache for five minutes; the Worker response also
    // supplies browser HTTP caching headers for client-side consumers.
    const response = await fetchCanonicalRuntime("event-discovery", url, fetcher, {
      cache: "force-cache",
      next: { revalidate: 300, tags: [`fieldview-event-discovery-${year}`] },
    });
    if (!response.ok) return null;
    const payload = await readCanonicalJson<{ year?: number; events?: unknown }>("event-discovery", response);
    if (payload.year !== year || !Array.isArray(payload.events)) return null;
    if (!payload.events.every((event) =>
      typeof event === "object" && event !== null &&
      typeof (event as { key?: unknown }).key === "string")) return null;
    return payload.events as FieldViewEvent[];
  } catch {
    return null;
  }
}

export async function getCanonicalTeamDiscovery(
  year: number,
  fetcher: typeof fetch = fetch,
): Promise<FieldViewTeam[] | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl || !Number.isSafeInteger(year)) return null;
  try {
    const url = new URL(`/teams/discovery?year=${year}`, baseUrl);
    const response = await fetchCanonicalRuntime("team-discovery", url, fetcher);
    if (!response.ok) return null;
    const payload = await readCanonicalJson<{ year?: number; teams?: unknown }>("team-discovery", response);
    if (payload.year !== year || !Array.isArray(payload.teams)) return null;
    if (!payload.teams.every((team) =>
      typeof team === "object" && team !== null &&
      typeof (team as { key?: unknown }).key === "string")) return null;
    return payload.teams as FieldViewTeam[];
  } catch {
    return null;
  }
}


/** Read the Worker-owned season-wide team investigation result. */
export async function getCanonicalTeamAnalytics(
  teamKey: string,
  year: number,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl || !teamKey || !Number.isSafeInteger(year)) return null;
  try {
    const url = new URL("/teams/" + encodeURIComponent(teamKey) + "/analytics?year=" + year, baseUrl);
    const response = await fetchCanonicalRuntime("team-analytics", url, fetcher);
    if (!response.ok) return null;
    const value = await readCanonicalJson<Record<string, unknown>>("team-analytics", response);
    if (value.team !== Number(teamKey.replace(/^frc/i, "")) || value.year !== year ||
        !Array.isArray(value.events) || typeof value.collection !== "object" || value.collection === null) return null;
    return value;
  } catch {
    return null;
  }
}

export type CanonicalTeamSnapshotResponse = {
  version: number;
  snapshot: FieldViewTeamState;
};

/** Read the canonical team aggregate; null means the canonical Worker snapshot is unavailable. */
export async function getCanonicalTeamSnapshot(
  teamKey: string,
  year: number,
  fetcher: typeof fetch = fetch,
): Promise<CanonicalTeamSnapshotResponse | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl || !teamKey || !Number.isSafeInteger(year)) return null;
  try {
    const url = new URL(`/teams/${encodeURIComponent(teamKey)}/snapshot?year=${year}`, baseUrl);
    const response = await fetchCanonicalRuntime("team-snapshot", url, fetcher);
    if (!response.ok) return null;
    const version = Number(response.headers.get("X-FieldView-Snapshot-Version"));
    if (!Number.isSafeInteger(version) || version < 0) return null;
    const snapshot = await readCanonicalJson<FieldViewTeamState>("team-snapshot", response);
    if (snapshot.team_key !== teamKey || snapshot.year !== year) return null;
    return { version, snapshot };
  } catch {
    return null;
  }
}
