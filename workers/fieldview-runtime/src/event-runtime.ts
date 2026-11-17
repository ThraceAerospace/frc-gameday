import { TBAApiClient } from "../../../packages/providers/tba/src/client.js";
import { TBA_ENDPOINTS } from "../../../packages/providers/tba/src/endpoints.js";
import {
  applyPollResponse,
  applyWebhookUpdate,
  createEndpointState,
  createPollRequestSnapshot,
  type EndpointState,
} from "./endpoint-state.js";
import type {
  DurableObjectStateLike,
  DurableObjectTransactionLike,
  RuntimeEnvironment,
} from "./cloudflare.js";
import { reconcilePolledEndpoint, reconcileWebhookEndpoint } from "./reconciliation.js";

interface PollTask {
  endpoint: string;
  dueAt: number;
  intervalMs: number;
  generation: number;
  attempts: number;
}

const TASK_PREFIX = "poll:";
const ENDPOINT_PREFIX = "endpoint:";

function endpointStorageKey(endpoint: string): string {
  return `${ENDPOINT_PREFIX}${endpoint}`;
}

function taskStorageKey(endpoint: string): string {
  return `${TASK_PREFIX}${endpoint}`;
}

function cacheMaxAgeSeconds(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(?:^|,)\\s*max-age\\s*=\\s*"?([0-9]+)"?/i);
  return match ? Number(match[1]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function eventResourceEndpoints(eventKey: string): string[] {
  return [
    TBA_ENDPOINTS.event(eventKey),
    TBA_ENDPOINTS.eventTeams(eventKey),
    TBA_ENDPOINTS.eventTeamStatuses(eventKey),
    TBA_ENDPOINTS.eventMatches(eventKey),
    TBA_ENDPOINTS.eventAlliances(eventKey),
    TBA_ENDPOINTS.eventOPRs(eventKey),
    TBA_ENDPOINTS.eventPredictions(eventKey),
    TBA_ENDPOINTS.eventRankings(eventKey),
    TBA_ENDPOINTS.eventAwards(eventKey),
    TBA_ENDPOINTS.eventMedia(eventKey),
    TBA_ENDPOINTS.eventDistrictPoints(eventKey),
    TBA_ENDPOINTS.eventAdvancementPoints(eventKey),
  ];
}

/**
 * One EventRuntime instance owns one event's provider endpoint state and
 * polling schedule. Network I/O always occurs outside storage transactions.
 */
export class EventRuntime {
  private readonly storage: DurableObjectStateLike["storage"];
  private readonly api: TBAApiClient;
  private readonly env: RuntimeEnvironment;
  private readonly eventKey: string;
  private readonly allowedEndpoints: Set<string>;

  constructor(state: DurableObjectStateLike, env: RuntimeEnvironment, eventKey?: string) {
    this.storage = state.storage;
    this.env = env;
    this.api = new TBAApiClient({
      apiKey: env.TBA_API_KEY,
      ...(env.fetcher ? { fetch: env.fetcher } : {}),
    });
    this.eventKey = eventKey ?? "";
    this.allowedEndpoints = new Set(this.eventKey ? eventResourceEndpoints(this.eventKey) : []);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Authorization") !== `Bearer ${this.env.RUNTIME_ADMIN_TOKEN}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (request.method === "POST" && url.pathname === "/schedule") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || !Array.isArray(body.endpoints) ||
          !body.endpoints.every((endpoint) => typeof endpoint === "string")) {
        return Response.json({ error: "Expected an endpoints array" }, { status: 400 });
      }
      const intervalMs = body.intervalMs;
      if (typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
        return Response.json({ error: "intervalMs must be an integer of at least 1000" }, { status: 400 });
      }
      const endpoints = body.endpoints as string[];
      if (endpoints.some((endpoint) => !this.allowedEndpoints.has(endpoint))) {
        return Response.json({ error: "Endpoint is not part of this event" }, { status: 400 });
      }
      await this.schedulePolls(endpoints, intervalMs);
      return Response.json({ scheduled: endpoints.length, event_key: this.eventKey });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.endpoint !== "string" || !("data" in body) ||
          !this.allowedEndpoints.has(body.endpoint)) {
        return Response.json({ error: "Invalid event endpoint update" }, { status: 400 });
      }
      await this.applyWebhook(body.endpoint, body.data);
      return Response.json({ accepted: true });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const entries = await this.storage.list<EndpointState<unknown>>({ prefix: ENDPOINT_PREFIX });
      return Response.json({
        event_key: this.eventKey,
        endpoints: Object.fromEntries(entries),
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  async schedulePolls(endpoints: string[], intervalMs: number, now = Date.now()): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      for (const endpoint of endpoints) {
        const key = taskStorageKey(endpoint);
        const previous = await transaction.get<PollTask>(key);
        const task: PollTask = {
          endpoint,
          dueAt: now,
          intervalMs,
          generation: (previous?.generation ?? 0) + 1,
          attempts: 0,
        };
        await transaction.put(key, task);
      }
      await this.rearm(transaction);
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // Reserve due work durably before making requests. A crash during fetch
    // leaves a retry deadline instead of losing the scheduled task.
    const dueTasks = await this.storage.transaction(async (transaction) => {
      const tasks = await transaction.list<PollTask>({ prefix: TASK_PREFIX });
      const due = [...tasks.values()].filter((task) => task.dueAt <= now);
      for (const task of due) {
        await transaction.put(taskStorageKey(task.endpoint), {
          ...task,
          dueAt: now + this.retryDelay(task),
          attempts: task.attempts + 1,
        });
      }
      await this.rearm(transaction);
      return due;
    });

    for (const task of dueTasks) {
      const succeeded = await this.pollEndpoint(task.endpoint);
      await this.storage.transaction(async (transaction) => {
        const key = taskStorageKey(task.endpoint);
        const current = await transaction.get<PollTask>(key);
        // An administrator may have replaced this task while its poll ran.
        if (!current || current.generation !== task.generation) return;
        const attempts = succeeded ? 0 : current.attempts;
        await transaction.put(key, {
          ...current,
          attempts,
          dueAt: Date.now() + (succeeded ? current.intervalMs : this.retryDelay(current)),
        });
        await this.rearm(transaction);
      });
    }
  }

  private retryDelay(task: PollTask): number {
    return Math.min(5 * 60_000, 2_000 * (2 ** Math.min(task.attempts, 7)));
  }

  private async rearm(transaction: DurableObjectTransactionLike): Promise<void> {
    const tasks = await transaction.list<PollTask>({ prefix: TASK_PREFIX });
    const nextDue = [...tasks.values()].reduce<number | null>(
      (next, task) => next === null || task.dueAt < next ? task.dueAt : next,
      null,
    );
    if (nextDue === null) await transaction.deleteAlarm();
    else await transaction.setAlarm(nextDue);
  }

  private async pollEndpoint(endpoint: string): Promise<boolean> {
    const stored = await this.storage.get<EndpointState<unknown>>(endpointStorageKey(endpoint));
    const initial = stored ?? createEndpointState<unknown>(endpoint);
    const requestSnapshot = createPollRequestSnapshot(initial);
    const headers = new Headers();
    if (requestSnapshot.ifNoneMatch) headers.set("If-None-Match", requestSnapshot.ifNoneMatch);

    let responseState:
      | { status: "modified"; data: unknown; etag: string | null; expiresAt: number | null }
      | { status: "not-modified"; expiresAt: number | null }
      | { status: "failed" };

    try {
      const response = await this.api.request(endpoint, { headers });
      const maxAge = cacheMaxAgeSeconds(response.headers.get("Cache-Control"));
      const expiresAt = maxAge === null ? null : Date.now() + maxAge * 1000;

      if (response.status === 304) {
        responseState = {
          status: "not-modified",
          expiresAt: expiresAt ?? initial.expiresAt,
        };
      } else if (!response.ok) {
        responseState = { status: "failed" };
      } else {
        responseState = {
          status: "modified",
          data: await response.json(),
          etag: response.headers.get("ETag"),
          expiresAt,
        };
      }
    } catch {
      responseState = { status: "failed" };
    }

    await this.storage.transaction(async (transaction) => {
      const key = endpointStorageKey(endpoint);
      const latest = await transaction.get<EndpointState<unknown>>(key) ?? initial;
      const next = applyPollResponse(
        latest,
        requestSnapshot,
        responseState,
        Date.now(),
        (current, fetched) => reconcilePolledEndpoint(endpoint, current, fetched),
      );
      await transaction.put(key, next);
    });

    return responseState.status !== "failed";
  }

  private async applyWebhook(endpoint: string, incoming: unknown): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const key = endpointStorageKey(endpoint);
      const current = await transaction.get<EndpointState<unknown>>(key) ??
        createEndpointState<unknown>(endpoint);
      const next = applyWebhookUpdate(
        current,
        incoming,
        Date.now(),
        (latest, update) => reconcileWebhookEndpoint(endpoint, latest, update),
      );
      await transaction.put(key, next);
    });
  }
}
