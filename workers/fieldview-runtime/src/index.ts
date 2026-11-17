import { EventRuntime } from "./event-runtime.ts";
import { Multiplexer } from "./multiplexer.ts";
import { EventScheduler } from "./event-scheduler.ts";
import type { RuntimeEnvironment } from "./cloudflare.ts";
import { verifyTbaWebhookHmac } from "./webhook-auth.ts";

export { EventRuntime, EventScheduler, Multiplexer };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorized(request: Request, env: RuntimeEnvironment): boolean {
  return Boolean(env.RUNTIME_ADMIN_TOKEN) &&
    request.headers.get("Authorization") === `Bearer ${env.RUNTIME_ADMIN_TOKEN}`;
}

export default {
  async fetch(request: Request, env: RuntimeEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/webhooks/tba" && request.method === "POST") {
      if (!env.TBA_WEBHOOK_SECRET) {
        return Response.json({ error: "Webhook secret is not configured" }, { status: 503 });
      }
      const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
      if (declaredLength > 1_000_000) {
        return Response.json({ error: "Webhook payload too large" }, { status: 413 });
      }
      const rawBody = await request.arrayBuffer();
      if (rawBody.byteLength > 1_000_000) {
        return Response.json({ error: "Webhook payload too large" }, { status: 413 });
      }
      const signature = request.headers.get("X-TBA-HMAC");
      if (!(await verifyTbaWebhookHmac(env.TBA_WEBHOOK_SECRET, signature, rawBody))) {
        return Response.json({ error: "Invalid TBA webhook signature" }, { status: 401 });
      }

      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(rawBody)); }
      catch { return Response.json({ error: "Invalid webhook JSON" }, { status: 400 }); }
      if (!isRecord(payload) || typeof payload.message_type !== "string" ||
          !isRecord(payload.message_data)) {
        return Response.json({ error: "Invalid TBA webhook payload" }, { status: 400 });
      }
      if (["ping", "verification", "broadcast"].includes(payload.message_type)) {
        return Response.json({ accepted: true });
      }
      const eventKey = payload.message_data.event_key;
      if (typeof eventKey !== "string" || !/^[a-zA-Z0-9_-]+$/.test(eventKey)) {
        return Response.json({ error: "Webhook has no valid event key" }, { status: 400 });
      }

      const digest = await crypto.subtle.digest("SHA-256", rawBody);
      const webhookId = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(eventKey));
      const headers = new Headers({
        Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN,
        "X-FieldView-Event-Key": eventKey,
        "X-FieldView-Webhook-Id": webhookId,
        "Content-Type": "application/json",
      });
      return stub.fetch(new Request("https://event-runtime/webhook", {
        method: "POST",
        headers,
        body: rawBody,
      }));
    }

    if (url.pathname === "/events/discovery" && request.method === "GET") {
      if (!env.EVENT_SCHEDULER) return Response.json({ error: "Event scheduler is not bound" }, { status: 503 });
      const scheduler = env.EVENT_SCHEDULER.get(env.EVENT_SCHEDULER.idFromName("global"));
      const query = new URLSearchParams();
      const year = url.searchParams.get("year");
      if (year !== null) query.set("year", year);
      return scheduler.fetch(new Request("https://event-scheduler/events?" + query.toString()));
    }

    if (url.pathname === "/stream" && request.method === "GET" && env.MULTIPLEXER) {
      const stub = env.MULTIPLEXER.get(env.MULTIPLEXER.idFromName("shared"));
      return stub.fetch(new Request("https://fieldview-multiplexer/stream", { method: "GET", headers: request.headers }));
    }

    if (url.pathname === "/internal/scheduler/start" || url.pathname === "/internal/scheduler/stop" || url.pathname === "/internal/scheduler/state") {
      if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!env.EVENT_SCHEDULER) return Response.json({ error: "Event scheduler is not bound" }, { status: 503 });
      const scheduler = env.EVENT_SCHEDULER.get(env.EVENT_SCHEDULER.idFromName("global"));
      const action = url.pathname.endsWith("/start") ? "start" : url.pathname.endsWith("/stop") ? "stop" : "state";
      return scheduler.fetch(new Request("https://event-scheduler/" + action, {
        method: action === "state" ? "GET" : "POST",
        headers: { Authorization: "Bearer " + env.RUNTIME_ADMIN_TOKEN },
      }));
    }

    if (url.pathname === "/health") {
      return Response.json({ service: "fieldview-runtime", status: "ok" });
    }

    // Public event reads expose only canonical snapshots and read-only
    // revision notifications. No user account or browser-held service secret
    // is required; administrative and mutation routes remain private below.
    const publicParts = url.pathname.split("/");
    const publicEventKey = publicParts[2];
    const publicAction = publicParts[3];
    const validPublicRoute = publicParts.length === 4 &&
      publicParts[1] === "events" &&
      /^[a-zA-Z0-9_-]+$/.test(publicEventKey ?? "") &&
      (publicAction === "snapshot" || publicAction === "stream");

    if (validPublicRoute && publicAction === "snapshot" && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (validPublicRoute && request.method === "GET") {
      const stub = env.EVENT_RUNTIME.get(env.EVENT_RUNTIME.idFromName(publicEventKey));
      const headers = new Headers({
        "X-FieldView-Event-Key": publicEventKey,
      });
      if (publicAction === "stream") {
        const upgrade = request.headers.get("Upgrade");
        if (upgrade) headers.set("Upgrade", upgrade);
      }
      const forwarded = new Request(
        `https://event-runtime/${publicAction}${url.search}`,
        { method: "GET", headers },
      );
      const response = await stub.fetch(forwarded);
      if (publicAction === "stream") return response;

      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Expose-Headers", "X-FieldView-Snapshot-Version");
      responseHeaders.set("Cache-Control", "no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    const parts = url.pathname.split("/");
    const eventKey = parts[3];
    const action = parts[4];
    const validRoute = parts.length === 5 && parts[1] === "internal" &&
      parts[2] === "events" && /^[a-zA-Z0-9_-]+$/.test(eventKey ?? "") &&
      ["schedule", "state", "snapshot", "stream"].includes(action ?? "");
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
