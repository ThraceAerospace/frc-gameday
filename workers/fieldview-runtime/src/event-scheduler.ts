import { TBAApiClient } from "../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";
import type { TBAEventSimple } from "../../../packages/providers/tba/src/types.ts";
import type { DurableObjectStateLike, RuntimeEnvironment } from "./cloudflare.ts";

const DISCOVERY_PREFIX = "discovery:";

export interface EventPollingPolicy {
  discoveryIntervalMs: number;
  upcomingIntervalMs: number;
  activeIntervalMs: number;
  completedRetentionMs: number;
}

export const DEFAULT_EVENT_POLLING_POLICY: EventPollingPolicy = {
  discoveryIntervalMs: 60 * 60_000,
  upcomingIntervalMs: 30 * 60_000,
  activeIntervalMs: 5 * 60_000,
  completedRetentionMs: 24 * 60 * 60_000,
};

function configured(value: string | number | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) {
    throw new Error(name + " must be an integer of at least 1000 milliseconds");
  }
  return parsed;
}

export function eventPollingPolicy(env: RuntimeEnvironment): EventPollingPolicy {
  return {
    discoveryIntervalMs: configured(env.EVENT_DISCOVERY_INTERVAL_MS, DEFAULT_EVENT_POLLING_POLICY.discoveryIntervalMs, "EVENT_DISCOVERY_INTERVAL_MS"),
    upcomingIntervalMs: configured(env.EVENT_UPCOMING_INTERVAL_MS, DEFAULT_EVENT_POLLING_POLICY.upcomingIntervalMs, "EVENT_UPCOMING_INTERVAL_MS"),
    activeIntervalMs: configured(env.EVENT_ACTIVE_INTERVAL_MS, DEFAULT_EVENT_POLLING_POLICY.activeIntervalMs, "EVENT_ACTIVE_INTERVAL_MS"),
    completedRetentionMs: configured(env.EVENT_COMPLETED_RETENTION_MS, DEFAULT_EVENT_POLLING_POLICY.completedRetentionMs, "EVENT_COMPLETED_RETENTION_MS"),
  };
}

export type EventLifecycle = "upcoming" | "active" | "completed" | "expired";

export interface EventLifecycleDecision {
  lifecycle: EventLifecycle;
  completedUntil: number | null;
}

/**
 * TBA discovery records expose date-only boundaries. Treat start_date as the
 * beginning of that UTC calendar day and end_date as its inclusive end.
 * This is scheduling metadata only; displayed event times always use the
 * event's IANA timezone in the product layer.
 */
export function classifyEventLifecycle(
  event: Pick<TBAEventSimple, "start_date" | "end_date">,
  now: number,
  policy: EventPollingPolicy,
): EventLifecycleDecision | null {
  const start = Date.parse(event.start_date + "T00:00:00.000Z");
  const end = Date.parse(event.end_date + "T23:59:59.999Z");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (now < start) return { lifecycle: "upcoming", completedUntil: null };
  if (now <= end) return { lifecycle: "active", completedUntil: null };
  const completedUntil = end + policy.completedRetentionMs;
  return now < completedUntil
    ? { lifecycle: "completed", completedUntil }
    : { lifecycle: "expired", completedUntil };
}

interface DiscoveryCache {
  etag: string | null;
  events: TBAEventSimple[];
  updatedAt: number;
}

export class EventScheduler {
  private readonly storage: DurableObjectStateLike["storage"];
  private readonly api: TBAApiClient;
  private readonly env: RuntimeEnvironment;

  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment) {
    this.storage = state.storage;
    this.env = env;
    this.api = new TBAApiClient({
      apiKey: env.TBA_API_KEY,
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authorized = Boolean(this.env.RUNTIME_ADMIN_TOKEN) &&
      request.headers.get("Authorization") === "Bearer " + this.env.RUNTIME_ADMIN_TOKEN;
    if (!authorized) return Response.json({ error: "Unauthorized" }, { status: 401 });

    if (request.method === "POST" && url.pathname === "/start") {
      await this.storage.put("scheduler:enabled", true);
      await this.storage.setAlarm(Date.now());
      return Response.json({ started: true });
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      await this.storage.put("scheduler:enabled", false);
      await this.storage.deleteAlarm();
      return Response.json({ started: false });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json({
        enabled: await this.storage.get<boolean>("scheduler:enabled") ?? false,
        lastRunAt: await this.storage.get<number>("scheduler:last-run-at") ?? null,
        lastError: await this.storage.get<string>("scheduler:last-error") ?? null,
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    if (await this.storage.get<boolean>("scheduler:enabled") !== true) return;
    const policy = eventPollingPolicy(this.env);
    try {
      await this.discoverAndSchedule(policy);
      await this.storage.delete("scheduler:last-error");
    } catch (error) {
      await this.storage.put("scheduler:last-error", error instanceof Error ? error.message : String(error));
    }
    await this.storage.put("scheduler:last-run-at", Date.now());
    await this.storage.setAlarm(Date.now() + policy.discoveryIntervalMs);
  }

  private async discoverAndSchedule(policy: EventPollingPolicy): Promise<void> {
    const year = new Date().getUTCFullYear();
    const events = new Map<string, TBAEventSimple>();
    for (const discoveryYear of [year - 1, year, year + 1]) {
      const endpoint = TBA_ENDPOINTS.events(discoveryYear);
      const cacheKey = DISCOVERY_PREFIX + discoveryYear;
      const cached = await this.storage.get<DiscoveryCache>(cacheKey);
      const headers = new Headers();
      if (cached?.etag) headers.set("If-None-Match", cached.etag);
      const response = await this.api.request(endpoint, { headers });
      let discovered: TBAEventSimple[];
      if (response.status === 304 && cached) {
        discovered = cached.events;
      } else if (response.ok) {
        discovered = await response.json() as TBAEventSimple[];
        if (!Array.isArray(discovered)) throw new Error("TBA event discovery returned a non-array payload");
        await this.storage.put(cacheKey, {
          etag: response.headers.get("ETag"),
          events: discovered,
          updatedAt: Date.now(),
        } satisfies DiscoveryCache);
      } else {
        throw new Error("TBA event discovery failed for " + discoveryYear + " with HTTP " + response.status);
      }
      for (const event of discovered) if (event.key) events.set(event.key, event);
    }

    for (const event of events.values()) {
      const decision = classifyEventLifecycle(event, Date.now(), policy);
      if (!decision) continue;
      const stub = this.env.EVENT_RUNTIME.get(this.env.EVENT_RUNTIME.idFromName(event.key));
      const response = await stub.fetch(new Request("https://event-runtime/lifecycle", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.env.RUNTIME_ADMIN_TOKEN,
          "X-FieldView-Event-Key": event.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lifecycle: decision.lifecycle,
          upcomingIntervalMs: policy.upcomingIntervalMs,
          activeIntervalMs: policy.activeIntervalMs,
          ...(decision.completedUntil === null ? {} : { completedUntil: decision.completedUntil }),
        }),
      }));
      if (!response.ok) throw new Error("Failed to schedule " + event.key + ": HTTP " + response.status);
    }
  }
}
