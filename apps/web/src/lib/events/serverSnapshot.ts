import type { FieldViewEvent, FieldViewEventSnapshot, FieldViewTeam, FieldViewTeamSnapshot } from "@fieldview/domain";

export type CanonicalEventSnapshotResponse = {
  version: number;
  snapshot: FieldViewEventSnapshot;
};

/**
 * Read the canonical event snapshot when a server-side runtime origin is
 * configured. A null result means the caller should retain its legacy path.
 */
export async function getCanonicalEventSnapshot(
  eventKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CanonicalEventSnapshotResponse | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl || !eventKey) return null;

  try {
    const url = new URL(`/events/${encodeURIComponent(eventKey)}/snapshot`, baseUrl);
    const response = await fetcher(url, { cache: "no-store" });
    if (!response.ok) return null;

    const version = Number(response.headers.get("X-FieldView-Snapshot-Version"));
    if (!Number.isSafeInteger(version) || version < 0) return null;

    const snapshot = await response.json() as FieldViewEventSnapshot;
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
    const response = await fetcher(url, { cache: "no-store" });
    if (!response.ok) return null;
    const value = await response.json() as CanonicalEventAnalyticsResponse;
    if (value.event_key !== eventKey || !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
    return value;
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
    const response = await fetcher(url, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json() as { year?: number; events?: unknown };
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
    const response = await fetcher(url, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json() as { year?: number; teams?: unknown };
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
    const response = await fetcher(url, { cache: "no-store" });
    if (!response.ok) return null;
    const value = await response.json() as Record<string, unknown>;
    if (value.team !== Number(teamKey.replace(/^frc/i, "")) || value.year !== year ||
        !Array.isArray(value.events) || typeof value.collection !== "object" || value.collection === null) return null;
    return value;
  } catch {
    return null;
  }
}

export type CanonicalTeamSnapshotResponse = {
  version: number;
  snapshot: FieldViewTeamSnapshot;
};

/** Read the canonical team aggregate; null leaves the caller's compatibility path available. */
export async function getCanonicalTeamSnapshot(
  teamKey: string,
  year: number,
  fetcher: typeof fetch = fetch,
): Promise<CanonicalTeamSnapshotResponse | null> {
  const baseUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!baseUrl || !teamKey || !Number.isSafeInteger(year)) return null;
  try {
    const url = new URL(`/teams/${encodeURIComponent(teamKey)}/snapshot?year=${year}`, baseUrl);
    const response = await fetcher(url, { cache: "no-store" });
    if (!response.ok) return null;
    const version = Number(response.headers.get("X-FieldView-Snapshot-Version"));
    if (!Number.isSafeInteger(version) || version < 0) return null;
    const snapshot = await response.json() as FieldViewTeamSnapshot;
    if (snapshot.team_key !== teamKey || snapshot.year !== year) return null;
    return { version, snapshot };
  } catch {
    return null;
  }
}
