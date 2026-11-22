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
  const season = year ?? new Date().getUTCFullYear();
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
      : action === "refresh" ? "refresh?year=" + season : null;
    if (!path) return Response.json({ error: "Unsupported team runtime dispatch" }, { status: 400 });
    const method = action === "state" || action === "snapshot" ? "GET" : "POST";
    const response = await stub.fetch(new Request("https://team-runtime/" + path, { method, headers }));
    if (response.ok) await registerRuntimeMarker(env, "team", key);
    return response;
  }

  if (!env.EVENT_RUNTIME) return Response.json({ error: "EventRuntime is unavailable" }, { status: 503 });
  const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(key));
  const paths: Record<string, string> = {
    participants: "participants",
    state: "state",
    refresh: "refresh",
    lifecycle: "lifecycle",
    schedule: "schedule",
    publish: "publish-state",
    recalculate: "recalculate",
    analytics: "analytics",
  };
  const path = paths[action];
  if (!path) return Response.json({ error: "Unsupported event runtime dispatch" }, { status: 400 });
  const method = action === "state" || action === "analytics" ? "GET" : "POST";
  const payload = { ...body };
  if (method === "GET") {
    delete payload.kind; delete payload.key; delete payload.action; delete payload.year;
  }
  const response = await stub.fetch(new Request("https://event-runtime/" + path, {
    method, headers,
    ...(method === "GET" ? {} : { body: JSON.stringify(payload) }),
  }));
  if (response.ok) await registerRuntimeMarker(env, "event", key);
  return response;
}

async function registerRuntimeMarker(env: RuntimeEnvironment, kind: RuntimeKind, key: string): Promise<void> {
  if (!env.DISCOVERY_STORE) return;
  const stub = env.DISCOVERY_STORE.get(env.DISCOVERY_STORE.idFromName("shared"));
  const prefix = kind === "event" ? "registry/runtime-events/" : "registry/runtime-teams/";
  const response = await stub.fetch(new Request("https://discovery-store/put", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: prefix + key + ".json", value: "{}" }),
  }));
  if (!response.ok) throw new Error("Unable to register runtime marker: HTTP " + response.status);
}
