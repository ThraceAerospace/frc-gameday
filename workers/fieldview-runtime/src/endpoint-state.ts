/**
 * Shared platform-independent endpoint state transitions for EventRuntime and TeamRuntime.
 * Cloudflare storage adapters persist these values and run transitions inside
 * short transactions. This module has no provider, domain, or platform imports.
 */
export type EndpointDataStatus = "unknown" | "available" | "stale" | "unavailable" | "failed";

export interface EndpointState<T> {
  endpoint: string;
  /** Availability of the retained representation, distinct from its value. */
  status: EndpointDataStatus;
  /** Latest locally reconciled representation, including accepted webhook updates. */
  data: T | null;
  /** Exact latest HTTP representation validated by etag; webhooks never modify it. */
  providerData: T | null;
  etag: string | null;
  lastFetchedAt: number | null;
  expiresAt: number | null;
  revision: number;
  /** Advances on each accepted 200 to fence concurrent polls; independent of canonical revision. */
  validatorRevision: number;
  lastAttemptAt: number | null;
  lastWebhookAt: number | null;
}

export type PollResponse<T> =
  | { status: "modified"; data: T; etag: string | null; expiresAt: number | null }
  | { status: "not-modified"; expiresAt: number | null }
  | { status: "unavailable" }
  | { status: "failed" };

function stableCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCanonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableCanonicalValue(record[key])]));
  }
  return value;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return (JSON.stringify(stableCanonicalValue(left)) ?? "undefined") ===
    (JSON.stringify(stableCanonicalValue(right)) ?? "undefined");
}

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
    endpoint, status: "unknown", data: null, providerData: null, etag: null, lastFetchedAt: null, expiresAt: null,
    revision: 0, validatorRevision: 0, lastAttemptAt: null, lastWebhookAt: null,
  };
}

/** Capture revision and validator before network I/O; never hold a transaction over fetch. */
export function createPollRequestSnapshot<T>(state: EndpointState<T>): PollRequestSnapshot {
  return {
    revision: state.revision,
    validatorRevision: state.validatorRevision,
    ifNoneMatch: state.lastFetchedAt === null ? null : state.etag,
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
  if (response.status === "failed" || response.status === "unavailable") {
    const hasRetainedRepresentation = current.lastFetchedAt !== null || current.lastWebhookAt !== null;
    return {
      ...current,
      status: hasRetainedRepresentation ? "stale" : response.status,
      lastAttemptAt: now,
    };
  }

  if (response.status === "not-modified") {
    // A 304 is a strict no-op. It validates the representation for the caller,
    // but must not mutate endpoint metadata, timestamps, validators, revisions,
    // diagnostics, or durable storage.
    return current;
  }

  const validatorIsCurrent = request.validatorRevision === current.validatorRevision;
  // A newer poll has already accepted a representation for this endpoint.
  // Unlike a webhook (which leaves validatorRevision unchanged), that response
  // supersedes this in-flight poll, so discard its data and validator together.
  if (!validatorIsCurrent) return { ...current, lastAttemptAt: now };

  const data = reconcile(current.data, response.data, request.revision);
  const canonicalChanged = !sameCanonicalValue(current.data, data);
  return {
    ...current,
    status: "available",
    data,
    providerData: response.data,
    // A 200 without ETag explicitly clears the old validator.
    etag: response.etag,
    lastFetchedAt: now,
    expiresAt: response.expiresAt,
    // Canonical revisions advance only when the reconciled representation changes.
    // Validator revisions advance for every accepted 200, including identical data.
    revision: current.revision + (canonicalChanged ? 1 : 0),
    validatorRevision: current.validatorRevision + 1,
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
  const data = reconcile(current.data, incoming);
  if (sameCanonicalValue(current.data, data)) return current;
  return {
    ...current,
    status: "available",
    data,
    revision: current.revision + 1,
    lastWebhookAt: now,
  };
}
