import { EventRuntime, eventResourceEndpoints } from "./event-runtime.js";
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

    const match = url.pathname.match(/^\\/internal\\/events\\/([a-zA-Z0-9_-]+)\\/(schedule|webhook|state)$/);
    if (!match || !authorized(request, env)) {
      return Response.json({ error: "Not found" }, { status: match ? 401 : 404 });
    }

    const [, eventKey, action] = match;
    const id = env.EVENT_RUNTIME.idFromName(eventKey);
    const stub = env.EVENT_RUNTIME.get(id);
    const headers = new Headers(request.headers);
    const forwarded = new Request(`https://event-runtime/${action}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: await request.clone().arrayBuffer() }),
    });
    const response = await stub.fetch(forwarded);
    if (action === "schedule" && response.ok) {
      // The route accepts explicit event-scoped resources only. This call is
      // also the canonical inventory used by administrative scheduling tools.
      void eventResourceEndpoints(eventKey);
    }
    return response;
  },
};
