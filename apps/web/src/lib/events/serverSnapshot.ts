import type { FieldViewEventSnapshot } from "@fieldview/domain";

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
  const baseUrl = process.env.FIELDVIEW_RUNTIME_URL;
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
