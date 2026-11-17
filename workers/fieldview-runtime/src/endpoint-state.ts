/**
 * Platform-independent endpoint state transitions for EventRuntime.
 * Cloudflare storage adapters persist these values and run transitions inside
 * short transactions. This module has no provider, domain, or platform imports.
 */
export interface EndpointState<T> {
  endpoint: string;
  data: T | null;
  etag: string | null;
  lastFetchedAt: number | null;
  expiresAt: number | null;
  revision: number;
  /** Advances only when a 200 response installs a new upstream validator state. */
  validatorRevision: number;
  lastAttemptAt: number | null;
  lastWebhookAt: number | null;
}

export type PollResponse<T> =
  | { status: "modified"; data: T; etag: string | null; expiresAt: number | null }
  | { status: "not-modified"; expiresAt: number | null }
  | { status: "failed" };

export interface PollRequestSnapshot {
  revision: number;
  validatorRevision: number;
  ifNoneMatch: string | null;
}

export function createEndpointState<T>(endpoint: string): EndpointState<T> {
  if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
    throw new Error("Endpoint state requires a provider-relative path");
  }
  return {
    endpoint, data: null, etag: null, lastFetchedAt: null, expiresAt: null,
    revision: 0, validatorRevision: 0, lastAttemptAt: null, lastWebhookAt: null,
  };
}

/** Capture revision and validator before network I/O; never hold a transaction over fetch. */
export function createPollRequestSnapshot<T>(state: EndpointState<T>): PollRequestSnapshot {
  return {
    revision: state.revision,
    validatorRevision: state.validatorRevision,
    ifNoneMatch: state.etag,
  };
}

/**
 * Apply the response to the latest state reread after network I/O.
 * Reconcile must merge useful intervening webhook changes with fetched data.
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
    // A delayed 304 only validates the ETag sent with that request. If another
    // poll installed a different validator, it must not refresh that validator's TTL.
    if (request.validatorRevision !== current.validatorRevision) {
      return { ...current, lastAttemptAt: now };
    }
    return { ...current, lastFetchedAt: now, expiresAt: response.expiresAt, lastAttemptAt: now };
  }

  const validatorIsCurrent = request.validatorRevision === current.validatorRevision;
  return {
    ...current,
    data: reconcile(current.data, response.data, request.revision),
    // A delayed response cannot roll back a validator accepted by a newer poll.
    // A 200 without ETag clears the old validator only for its current generation.
    etag: validatorIsCurrent ? response.etag : current.etag,
    lastFetchedAt: validatorIsCurrent ? now : current.lastFetchedAt,
    expiresAt: validatorIsCurrent ? response.expiresAt : current.expiresAt,
    revision: current.revision + 1,
    validatorRevision: validatorIsCurrent ? current.validatorRevision + 1 : current.validatorRevision,
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
    lastWebhookAt: now,
  };
}
