/**
 * Platform-independent endpoint state transitions for EventRuntime.
 * Cloudflare storage adapters persist these values and run transitions inside
 * short transactions. This module has no provider, domain, or platform imports.
 */
export interface EndpointState<T> {
  endpoint: string;
  data: T | null;
  /** Validator for the upstream HTTP resource representation. */
  etag: string | null;
  lastFetchedAt: number | null;
  expiresAt: number | null;
  /** Monotonic local revision used to detect overlapping inputs. */
  revision: number;
  lastAttemptAt: number | null;
}

export type PollResponse<T> =
  | { status: "modified"; data: T; etag: string | null; expiresAt: number | null }
  | { status: "not-modified"; expiresAt: number | null }
  | { status: "failed" };

export interface PollRequestSnapshot {
  revision: number;
  ifNoneMatch: string | null;
}

export function createEndpointState<T>(endpoint: string): EndpointState<T> {
  if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
    throw new Error("Endpoint state requires a provider-relative path");
  }
  return {
    endpoint, data: null, etag: null, lastFetchedAt: null,
    expiresAt: null, revision: 0, lastAttemptAt: null,
  };
}

/** Capture revision and validator before network I/O; do not hold a transaction over fetch. */
export function createPollRequestSnapshot<T>(state: EndpointState<T>): PollRequestSnapshot {
  return { revision: state.revision, ifNoneMatch: state.etag };
}

/**
 * Apply the response to the latest state reread after network I/O.
 * Reconcile must merge useful intervening webhook changes with the fetched data.
 * A changed revision alone is not grounds for discarding a useful poll response.
 */
export function applyPollResponse<T>(
  current: EndpointState<T>,
  request: PollRequestSnapshot,
  response: PollResponse<T>,
  now: number,
  reconcile: (latest: T | null, fetched: T, requestRevision: number) => T,
): EndpointState<T> {
  if (response.status === "failed") return { ...current, lastAttemptAt: now };
  if (response.status === "not-modified") {
    return { ...current, lastFetchedAt: now, expiresAt: response.expiresAt, lastAttemptAt: now };
  }
  return {
    ...current,
    data: reconcile(current.data, response.data, request.revision),
    // A 200 without an ETag explicitly clears the old validator.
    etag: response.etag,
    lastFetchedAt: now,
    expiresAt: response.expiresAt,
    revision: current.revision + 1,
    lastAttemptAt: now,
  };
}

/** Webhook edits local state, not the upstream HTTP validator or fetch timestamp. */
export function applyWebhookUpdate<T>(
  current: EndpointState<T>,
  incoming: T,
  now: number,
  reconcile: (latest: T | null, incoming: T) => T,
): EndpointState<T> {
  return {
    ...current,
    data: reconcile(current.data, incoming),
    revision: current.revision + 1,
    lastAttemptAt: now,
  };
}
