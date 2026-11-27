import { TBAApiClient } from "../../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../../packages/providers/tba/src/endpoints.ts";
import { StatboticsApiClient } from "../../../../packages/providers/statbotics/src/client.ts";
import { STATBOTICS_ENDPOINTS } from "../../../../packages/providers/statbotics/src/endpoints.ts";
import { FRCColorsApiClient } from "../../../../packages/providers/frc-colors/src/client.ts";
import { FRC_COLORS_ENDPOINTS } from "../../../../packages/providers/frc-colors/src/endpoints.ts";
import { createEndpointState, type EndpointState } from "../runtime/endpoint-state.ts";
import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import type { RuntimeBootstrapBundle, RuntimeBootstrapKind } from "../runtime/bootstrap.ts";

type Provider = "tba" | "statbotics" | "frc-colors";
type Resource = { provider: Provider; endpoint: string };

function eventResources(eventKey: string): Resource[] {
  return [
    ...[
      TBA_ENDPOINTS.event(eventKey), TBA_ENDPOINTS.eventTeams(eventKey),
      TBA_ENDPOINTS.eventTeamStatuses(eventKey), TBA_ENDPOINTS.eventMatches(eventKey),
      TBA_ENDPOINTS.eventAlliances(eventKey), TBA_ENDPOINTS.eventOPRs(eventKey),
      TBA_ENDPOINTS.eventPredictions(eventKey), TBA_ENDPOINTS.eventRankings(eventKey),
      TBA_ENDPOINTS.eventAwards(eventKey), TBA_ENDPOINTS.eventMedia(eventKey),
      TBA_ENDPOINTS.eventDistrictPoints(eventKey), TBA_ENDPOINTS.eventAdvancementPoints(eventKey),
    ].map((endpoint) => ({ provider: "tba" as const, endpoint })),
    { provider: "statbotics", endpoint: STATBOTICS_ENDPOINTS.matches({ event: eventKey }, 1000, 0) },
  ];
}

function teamResources(teamKey: string, year: number): Resource[] {
  const teamNumber = Number(teamKey.replace(/^frc/i, ""));
  return [
    { provider: "tba", endpoint: TBA_ENDPOINTS.team(teamKey) },
    { provider: "tba", endpoint: TBA_ENDPOINTS.teamDistricts(teamKey) },
    { provider: "tba", endpoint: TBA_ENDPOINTS.teamEvents(teamKey, year) },
    { provider: "tba", endpoint: TBA_ENDPOINTS.teamMedia(teamKey, year) },
    { provider: "statbotics", endpoint: STATBOTICS_ENDPOINTS.teamYear(teamNumber, year) },
    { provider: "statbotics", endpoint: STATBOTICS_ENDPOINTS.teamEvents({ team: teamNumber, year }) },
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
  const statbotics = new StatboticsApiClient({
    ...(env.STATBOTICS_API_BASE_URL ? { baseUrl: env.STATBOTICS_API_BASE_URL } : {}),
    ...(env.fetcher ? { fetch: env.fetcher } : {}),
  });
  const colors = new FRCColorsApiClient(env.fetcher ? { fetch: env.fetcher } : {});
  const resources = kind === "event" ? eventResources(key) : teamResources(key, year);

  const states = await Promise.all(resources.map(async (resource): Promise<EndpointState<unknown>> => {
    const state = createEndpointState<unknown>(resource.endpoint);
    const now = Date.now();
    try {
      const client = resource.provider === "tba" ? tba : resource.provider === "statbotics" ? statbotics : colors;
      const response = await client.request(resource.endpoint);
      const expiresAt = cacheMaxAge(response.headers.get("Cache-Control"));
      if (response.status === 404) {
        return { ...state, status: "unavailable", lastAttemptAt: now };
      }
      if (!response.ok) {
        return { ...state, status: "failed", lastAttemptAt: now };
      }
      const data: unknown = await response.json();
      return {
        ...state, status: "available", data, providerData: data,
        etag: response.headers.get("ETag"),
        lastFetchedAt: now,
        expiresAt: expiresAt === null ? null : now + expiresAt * 1000,
        revision: 1, validatorRevision: 1, lastAttemptAt: now,
      };
    } catch {
      return { ...state, status: "failed", lastAttemptAt: now };
    }
  }));

  return {
    version: 1, bootstrap_id: bootstrapId, kind, key, year,
    acquired_at: Date.now(), resources: states,
  };
}
