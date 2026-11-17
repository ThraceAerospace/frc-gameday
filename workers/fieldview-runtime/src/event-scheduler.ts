import { TBAApiClient } from "../../../packages/providers/tba/src/client.ts";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.ts";
import { normalizeFieldViewEvent } from "../../../packages/domain/src/normalization/event.ts";
import type { TBAEvent } from "../../../packages/providers/tba/src/types.ts";
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

function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return { year, month, day };
}

function nextDateOnly(value: string): string | null {
  const parts = parseDateOnly(value);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + 86_400_000)
    .toISOString().slice(0, 10);
}

/** Convert local midnight in an IANA timezone to its UTC instant. */
function zonedMidnight(value: string, timeZone: string): number | null {
  const date = parseDateOnly(value);
  if (!date || !timeZone) return null;
  const target = Date.UTC(date.year, date.month - 1, date.day);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    let candidate = target;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const values = new Map(formatter.formatToParts(new Date(candidate))
        .map((part) => [part.type, part.value]));
      const represented = Date.UTC(
        Number(values.get("year")),
        Number(values.get("month")) - 1,
        Number(values.get("day")),
        Number(values.get("hour")),
        Number(values.get("minute")),
        Number(values.get("second")),
      );
      const adjustment = target - represented;
      if (adjustment === 0) return candidate;
      candidate += adjustment;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * TBA event dates are local calendar dates. Classify their boundaries in the
 * event's IANA timezone, including DST transitions; the end date is inclusive.
 */
export function classifyEventLifecycle(
  event: Pick<TBAEvent, "start_date" | "end_date" | "timezone">,
  now: number,
  policy: EventPollingPolicy,
): EventLifecycleDecision | null {
  const endExclusiveDate = nextDateOnly(event.end_date);
  if (!endExclusiveDate || typeof event.timezone !== "string" || event.timezone.length === 0) return null;
  const start = zonedMidnight(event.start_date, event.timezone);
  const endExclusive = zonedMidnight(endExclusiveDate, event.timezone);
  if (start === null || endExclusive === null || endExclusive <= start) return null;
  const end = endExclusive - 1;
  if (now < start) return { lifecycle: "upcoming", completedUntil: null };
  if (now <= end) return { lifecycle: "active", completedUntil: null };
  const completedUntil = end + policy.completedRetentionMs;
  return now < completedUntil
    ? { lifecycle: "completed", completedUntil }
    : { lifecycle: "expired", completedUntil };
}

interface DiscoveryCache {
  etag: string | null;
  events: TBAEvent[];
  /** Retrieval time of the retained payload version. */
  updatedAt: number;
  /** Most recent successful 200/304 validation of that payload. */
  checkedAt?: number;
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
    if (request.method === "GET" && url.pathname === "/events") {
      const year = Number(url.searchParams.get("year"));
      if (!Number.isSafeInteger(year) || year < 1992 || year > 2200) {
        return Response.json({ error: "Invalid discovery year" }, { status: 400 });
      }
      const cached = await this.storage.get<DiscoveryCache>(DISCOVERY_PREFIX + year);
      if (!cached) return Response.json({ error: "Event discovery cache is not ready" }, { status: 503 });
      const retrievedAt = new Date(cached.updatedAt).toISOString();
      const checkedAt = cached.checkedAt ?? cached.updatedAt;
      const sourceStatus = Date.now() - checkedAt > eventPollingPolicy(this.env).discoveryIntervalMs * 2
        ? "stale" as const
        : "available" as const;
      const events = cached.events.map((event) => normalizeFieldViewEvent(event, {
        tba_event: {
          status: sourceStatus,
          retrieved_at: retrievedAt,
          ...(cached.etag === null ? {} : { validator: cached.etag }),
        },
      }));
      return Response.json(
        { year, events, updatedAt: cached.updatedAt, checkedAt },
        {
          headers: {
            "Cache-Control": "public, max-age=300, stale-while-revalidate=300",
            ...(cached.etag === null ? {} : { ETag: cached.etag }),
          },
        },
      );
    }

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
    const events = new Map<string, TBAEvent>();
    for (const discoveryYear of [year - 1, year, year + 1]) {
      const endpoint = TBA_ENDPOINTS.events(discoveryYear);
      const cacheKey = DISCOVERY_PREFIX + discoveryYear;
      const cached = await this.storage.get<DiscoveryCache>(cacheKey);
      const headers = new Headers();
      if (cached?.etag) headers.set("If-None-Match", cached.etag);
      const response = await this.api.request(endpoint, { headers });
      let discovered: TBAEvent[];
      if (response.status === 304 && cached) {
        discovered = cached.events;
        await this.storage.put(cacheKey, { ...cached, checkedAt: Date.now() } satisfies DiscoveryCache);
      } else if (response.ok) {
        discovered = await response.json() as TBAEvent[];
        if (!Array.isArray(discovered)) throw new Error("TBA event discovery returned a non-array payload");
        const retrievedAt = Date.now();
        await this.storage.put(cacheKey, {
          etag: response.headers.get("ETag"),
          events: discovered,
          updatedAt: retrievedAt,
          checkedAt: retrievedAt,
        } satisfies DiscoveryCache);
      } else {
        throw new Error("TBA event discovery failed for " + discoveryYear + " with HTTP " + response.status);
      }
      for (const event of discovered) if (event.key) events.set(event.key, event);
    }

    const scheduledKeys = new Set(await this.storage.get<string[]>("scheduler:event-keys") ?? []);
    for (const event of events.values()) {
      const decision = classifyEventLifecycle(event, Date.now(), policy);
      if (!decision) continue;
      // Historical event lists contain years of completed events. Only send an
      // expiry instruction for events this scheduler previously activated.
      if (decision.lifecycle === "expired" && !scheduledKeys.has(event.key)) continue;
      if (decision.lifecycle === "expired") scheduledKeys.delete(event.key);
      else scheduledKeys.add(event.key);
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
    await this.storage.put("scheduler:event-keys", [...scheduledKeys]);
  }
}
