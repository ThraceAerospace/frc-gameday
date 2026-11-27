import type { EndpointState } from "./endpoint-state.ts";

export type RuntimeBootstrapKind = "event" | "team";

export interface RuntimeBootstrapBundle {
  version: 1;
  bootstrap_id: string;
  kind: RuntimeBootstrapKind;
  key: string;
  year: number;
  acquired_at: number;
  resources: Array<EndpointState<unknown>>;
}

export interface RuntimeBootstrapReceipt {
  bootstrap_id: string;
  accepted: boolean;
  duplicate: boolean;
  kind: RuntimeBootstrapKind;
  key: string;
  year: number;
  snapshot_revision: number;
  publication_status: "complete" | "partial" | "failed";
}

export function validateRuntimeBootstrapBundle(
  value: unknown,
  expected: { kind: RuntimeBootstrapKind; key: string; year: number },
): value is RuntimeBootstrapBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  if (bundle.version !== 1 || bundle.kind !== expected.kind || bundle.key !== expected.key ||
      bundle.year !== expected.year ||
      (expected.kind === "event" && (!/^[0-9]{4}[a-zA-Z0-9_-]+$/.test(expected.key) || !expected.key.startsWith(String(expected.year)))) ||
      (expected.kind === "team" && !/^frc[0-9]+$/.test(expected.key)) ||
      typeof bundle.bootstrap_id !== "string" ||
      !/^[a-zA-Z0-9:_-]{1,160}$/.test(bundle.bootstrap_id) ||
      !Number.isSafeInteger(bundle.acquired_at) || !Array.isArray(bundle.resources) ||
      bundle.resources.length < 1 || bundle.resources.length > 32) return false;

  const endpoints = new Set<string>();
  for (const item of bundle.resources) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const resource = item as Record<string, unknown>;
    if (!("data" in resource) || !("providerData" in resource) ||
        typeof resource.endpoint !== "string" || !resource.endpoint.startsWith("/") ||
        resource.endpoint.startsWith("//") || endpoints.has(resource.endpoint) ||
        !["available", "unavailable", "failed", "stale", "unknown"].includes(String(resource.status)) ||
        !Number.isSafeInteger(resource.revision) || Number(resource.revision) < 0 ||
        !Number.isSafeInteger(resource.validatorRevision) || Number(resource.validatorRevision) < 0 ||
        (resource.etag !== null && typeof resource.etag !== "string") ||
        (resource.lastFetchedAt !== null && !Number.isSafeInteger(resource.lastFetchedAt)) ||
        (resource.expiresAt !== null && !Number.isSafeInteger(resource.expiresAt)) ||
        (resource.lastAttemptAt !== null && !Number.isSafeInteger(resource.lastAttemptAt)) ||
        (resource.lastWebhookAt !== null && !Number.isSafeInteger(resource.lastWebhookAt))) return false;
    endpoints.add(resource.endpoint);
  }
  return true;
}
