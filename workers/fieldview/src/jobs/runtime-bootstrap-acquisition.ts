import { TBAApiClient } from "../../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../../packages/providers/tba/src/endpoints.ts";
import { FRCColorsApiClient } from "../../../../packages/providers/frc-colors/src/client.ts";
import { FRC_COLORS_ENDPOINTS } from "../../../../packages/providers/frc-colors/src/endpoints.ts";
import { createEndpointState, type EndpointState } from "../runtime/endpoint-state.ts";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import type { RuntimeBootstrapBundle, RuntimeBootstrapKind } from "../runtime/bootstrap.ts";

type Provider = "tba" | "frc-colors";
type Resource = { provider: Provider; endpoint: string };

function eventResources(eventKey: string): Resource[] {
  return [
    { provider: "tba", endpoint: TBA_ENDPOINTS.event(eventKey) },
    { provider: "tba", endpoint: TBA_ENDPOINTS.eventTeams(eventKey) },
  ];
}

function teamResources(teamKey: string, year: number): Resource[] {
  const teamNumber = Number(teamKey.replace(/^frc/i, ""));
  return [
    { provider: "tba", endpoint: TBA_ENDPOINTS.team(teamKey) },
    { provider: "tba", endpoint: TBA_ENDPOINTS.teamEvents(teamKey, year) },
    { provider: "frc-colors", endpoint: FRC_COLORS_ENDPOINTS.team(teamNumber) },
  ];
}

function cacheMaxAge(value: string | null): number | null {
  const directive = value?.split(",").map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("max-age="));
  if (!directive) return null;
  const seconds = Number(directive.slice(8).replace(/"/g, ""));
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

export async function acquireRuntimeBootstrap(
  env: RuntimeEnvironment,
  kind: RuntimeBootstrapKind,
  key: string,
  year: number,
  bootstrapId: string,
): Promise<RuntimeBootstrapBundle> {
  const tba = new TBAApiClient({ apiKey: env.TBA_API_KEY, ...(env.fetcher ? { fetch: env.fetcher } : {}) });
  const colors = kind === "team"
    ? new FRCColorsApiClient(env.fetcher ? { fetch: env.fetcher } : {})
    : null;
  const resources = kind === "event" ? eventResources(key) : teamResources(key, year);

  const states: EndpointState<unknown>[] = [];
  // Minimal baseline seed only: EventRuntime gets event + roster; TeamRuntime
  // gets team + season events + optional FRC-Colors. Competition resources are
  // acquired later by the active polling coordinator. Keep requests sequential.
  for (const resource of resources) {
    const state = createEndpointState<unknown>(resource.endpoint);
    const now = Date.now();
    try {
      const client = resource.provider === "tba" ? tba : colors;
      if (!client) throw new Error("Provider is not available for this bootstrap tier");
      const response = await client.request(resource.endpoint);
      const expiresAt = cacheMaxAge(response.headers.get("Cache-Control"));
      if (response.status === 404) {
        states.push({ ...state, status: "unavailable", lastAttemptAt: now });
      } else if (!response.ok) {
        states.push({ ...state, status: "failed", lastAttemptAt: now });
      } else {
        const data: unknown = await response.json();
        states.push({
          ...state, status: "available", data, providerData: data,
          etag: response.headers.get("ETag"),
          lastFetchedAt: now,
          expiresAt: expiresAt === null ? null : now + expiresAt * 1000,
          revision: 1, validatorRevision: 1, lastAttemptAt: now,
        });
      }
    } catch {
      states.push({ ...state, status: "failed", lastAttemptAt: now });
    }
  }

  return {
    version: 1, bootstrap_id: bootstrapId, kind, key, year,
    acquired_at: Date.now(), resources: states,
  };
}
