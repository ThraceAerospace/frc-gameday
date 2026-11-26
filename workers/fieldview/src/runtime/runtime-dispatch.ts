import type { RuntimeEnvironment } from "./cloudflare.ts";

export type RuntimeKind = "event" | "team";

/** In-process equivalent of the former Runtime /internal/workflows/dispatch route. */
export async function dispatchRuntime(
  env: RuntimeEnvironment,
  kind: RuntimeKind,
  key: string,
  action: string,
  body: Record<string, unknown> = {},
  year?: number,
): Promise<Response> {
  if (!env.RUNTIME_ADMIN_TOKEN) return Response.json({ error: "Runtime authorization is unavailable" }, { status: 503 });
  if (kind === "team" && !/^frc\d+$/.test(key)) return Response.json({ error: "Invalid team key" }, { status: 400 });
  if (kind === "event" && !/^[a-zA-Z0-9_-]+$/.test(key)) return Response.json({ error: "Invalid event key" }, { status: 400 });
  const season = year ?? (kind === "team" ? await readCurrentSeason(env) : Number(key.slice(0, 4)));
  if (season === null) return Response.json({ error: "TBA current season is unavailable" }, { status: 503 });
  if (!Number.isInteger(season) || season < 1992 || season > 2200) {
    return Response.json({ error: "Invalid season year" }, { status: 400 });
  }

  const headers = new Headers({
    Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
    "Content-Type": "application/json",
    ...(kind === "team" ? { "X-FieldView-Team-Key": key } : { "X-FieldView-Event-Key": key }),
  });

  if (kind === "team") {
    if (!env.TEAM_RUNTIME) return Response.json({ error: "TeamRuntime is unavailable" }, { status: 503 });
    const stub = env.TEAM_RUNTIME.get(env.TEAM_RUNTIME.idFromName(key));
    const path = action === "seed" ? "seed?year=" + season
      : action === "state" ? "state?year=" + season
      : action === "snapshot" ? "snapshot?year=" + season + "&noSchedule=1"
      : action === "refresh" ? "refresh?year=" + season
      : action === "readiness" ? "readiness?year=" + season
      : action === "pending-analytics" ? "pending-event-analytics?year=" + season : null;
    if (!path) return Response.json({ error: "Unsupported team runtime dispatch" }, { status: 400 });
    const method = action === "state" || action === "snapshot" || action === "pending-analytics" ? "GET" : "POST";
    const response = await stub.fetch(new Request("https://team-runtime/" + path, {
      method, headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }));
    if (response.ok && (action === "refresh" || action === "seed" || action === "resource-refresh")) {
      const refreshResult = await response.clone().json().catch(() => null) as {
        team_state_revision?: unknown;
        affected_events?: Array<{ event_key?: unknown; team_event_revision?: unknown }>;
      } | null;
      const relatedEventKey = body !== null && typeof body === "object" && !Array.isArray(body) &&
        typeof (body as Record<string, unknown>).related_event_key === "string"
        ? (body as Record<string, unknown>).related_event_key as string
        : null;
      if (refreshResult && Number.isSafeInteger(refreshResult.team_state_revision) &&
          Array.isArray(refreshResult.affected_events)) {
        const affectedEvents = relatedEventKey
          ? refreshResult.affected_events.filter((affected) => affected.event_key === relatedEventKey)
          : refreshResult.affected_events;

      }
    }
    if (response.ok && action !== "readiness" && action !== "pending-analytics") await registerRuntimeMarker(env, "team", key);
    return response;
  }

  if (!env.EVENT_RUNTIME) return Response.json({ error: "EventRuntime is unavailable" }, { status: 503 });
  const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(key));
  const paths: Record<string, string> = {
    participants: "participants",
    readiness: "readiness",
    state: "state",
    refresh: "refresh",
    lifecycle: "lifecycle",
    schedule: "schedule",
    publish: "publish-state",
    analytics: "analytics",
  };
  const path = paths[action];
  if (!path) return Response.json({ error: "Unsupported event runtime dispatch" }, { status: 400 });
  const method = action === "state" || action === "analytics" ? "GET" : "POST";
  const payload = { ...body };
  delete payload.kind; delete payload.key; delete payload.action; delete payload.year;

  // EventRuntime requires polling intervals when its lifecycle is initialized.
  // Keep these aligned with the legacy dispatch route and Wrangler environment.
  if (action === "lifecycle") {
    payload.upcomingIntervalMs = Number(env.EVENT_UPCOMING_INTERVAL_MS ?? 30 * 60_000);
    payload.activeIntervalMs = Number(env.EVENT_ACTIVE_INTERVAL_MS ?? 5 * 60_000);
  }

  const response = await stub.fetch(new Request("https://event-runtime/" + path, {
    method, headers,
    ...(method === "GET" ? {} : { body: JSON.stringify(payload) }),
  }));
  if (response.ok && action !== "readiness") await registerRuntimeMarker(env, "event", key);
  return response;
}

async function registerRuntimeMarker(env: RuntimeEnvironment, kind: RuntimeKind, key: string): Promise<void> {
  if (!env.DISCOVERY_STORE) return;
  const stub = env.DISCOVERY_STORE.get(env.DISCOVERY_STORE.idFromName("shared"));
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  const markerKey = prefix + key + ".json";
  const existing = await stub.fetch(new Request(
    "https://discovery-store/get?key=" + encodeURIComponent(markerKey),
  ));
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error("Unable to inspect runtime marker: HTTP " + existing.status);
  }
  const response = await stub.fetch(new Request("https://discovery-store/put", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: markerKey, value: "{}" }),
  }));
  if (!response.ok) throw new Error("Unable to register runtime marker: HTTP " + response.status);
}


async function readCurrentSeason(env: RuntimeEnvironment): Promise<number | null> {
  if (!env.DISCOVERY_STORE) return null;
  const stub = env.DISCOVERY_STORE.get(env.DISCOVERY_STORE.idFromName("shared"));
  const response = await stub.fetch(new Request(
    "https://discovery-store/get?key=" + encodeURIComponent("discovery/current-season.json"),
  ));
  if (!response.ok) return null;
  const current = await response.json().catch(() => null) as { year?: unknown } | null;
  return current && Number.isInteger(current.year) &&
    Number(current.year) >= 1992 && Number(current.year) <= 2200
    ? Number(current.year)
    : null;
}
