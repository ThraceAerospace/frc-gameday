/**
 * Immutable provider response history stored beside EventRuntime endpoint
 * state. This is infrastructure provenance, not a second domain/DTO model.
 */
import type { EndpointState, PollResponse } from "./endpoint-state.ts";

export interface ProviderSourceVersion<T> {
  endpoint: string;
  validatorRevision: number;
  retrievedAt: number;
  etag: string | null;
  /** Exact provider response payload, before webhook reconciliation. */
  data: T;
}

export function createProviderSourceVersion<T>(
  previous: EndpointState<T>,
  next: EndpointState<T>,
  response: PollResponse<T>,
  now: number,
): ProviderSourceVersion<T> | null {
  if (response.status !== "modified" ||
      next.validatorRevision <= previous.validatorRevision) {
    return null;
  }
  return {
    endpoint: next.endpoint,
    validatorRevision: next.validatorRevision,
    retrievedAt: now,
    etag: response.etag,
    data: response.data,
  };
}
