import { EventRuntime } from "./event-runtime.js";
import type { RuntimeEnvironment } from "./cloudflare.js";

export { EventRuntime };

function authorized(request: Request, env: RuntimeEnvironment): boolean {
  return Boolean(env.RUNTIME_ADMIN_TOKEN) &&
    request.headers.get("Authorization") === `Bearer ${env.RUNTIME_ADMIN_TOKEN}`;
}

export default {
  async fetch(request: Request, env: RuntimeEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ service: "fieldview-runtime", status: "ok" });
    }

    const parts = url.pathname.split("/");
    const eventKey = parts[3];
    const action = parts[4];
    const validRoute = parts.length === 5 && parts[1] === "internal" &&
      parts[2] === "events" && /^[a-zA-Z0-9_-]+$/.test(eventKey ?? "") &&
      ["schedule", "webhook", "state"].includes(action ?? "");
    if (!validRoute || !authorized(request, env)) {
      return Response.json({ error: "Not found" }, { status: validRoute ? 401 : 404 });
    }

    const id = env.EVENT_RUNTIME.idFromName(eventKey);
    const stub = env.EVENT_RUNTIME.get(id);
    const headers = new Headers(request.headers);
    headers.set("X-FieldView-Event-Key", eventKey);
    const forwarded = new Request(`https://event-runtime/${action}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: await request.clone().arrayBuffer() }),
    });
    return stub.fetch(forwarded);
  },
};
