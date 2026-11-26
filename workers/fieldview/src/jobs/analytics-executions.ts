import type { RuntimeEnvironment } from "../runtime/cloudflare.ts";
import { D1RecordStore, type D1RecordStorage } from "../runtime/d1-record-store.ts";

export type AnalyticsExecutionStatus = "running" | "retry_scheduled" | "completed" | "failed";

export interface AnalyticsExecutionRecord {
  execution_id: string;
  event_key: string;
  retry_key: string;
  workflow_id: string;
  affected_team_keys: string[] | null;
  requested_at: number;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
  attempt: number;
  status: AnalyticsExecutionStatus;
  retry_workflow_id?: string;
  next_retry_at?: number;
  source_revision?: number;
  outcome?: {
    registered_team_count?: number;
    recalculated_team_count?: number;
    retained_team_result_count?: number;
    published_team_result_count?: number;
    acknowledged_team_result_count?: number;
  };
  error_class?: string;
}

const PREFIX = "system/analytics-executions/";
const MAX_ATTEMPTS = 2;

function validRecord(value: unknown): value is AnalyticsExecutionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AnalyticsExecutionRecord>;
  return typeof record.execution_id === "string" &&
    typeof record.event_key === "string" &&
    typeof record.retry_key === "string" &&
    typeof record.workflow_id === "string" &&
    (record.affected_team_keys === null || Array.isArray(record.affected_team_keys)) &&
    Number.isSafeInteger(record.requested_at) &&
    Number.isSafeInteger(record.started_at) &&
    Number.isSafeInteger(record.updated_at) &&
    (record.completed_at === null || Number.isSafeInteger(record.completed_at)) &&
    Number.isSafeInteger(record.attempt) &&
    ["running", "retry_scheduled", "completed", "failed"].includes(String(record.status));
}

/** Typed, bounded execution ledger over the System Records D1 table. */
export class AnalyticsExecutionRepository {
  constructor(private readonly storage: D1RecordStorage) {}

  static fromEnvironment(env: RuntimeEnvironment): AnalyticsExecutionRepository {
    const storage = env.DISCOVERY_STORAGE ?? (env.DB ? new D1RecordStore(env.DB) : null);
    if (!storage) throw new Error("System Records D1 storage is unavailable");
    return new AnalyticsExecutionRepository(storage);
  }

  static key(executionId: string): string {
    return PREFIX + encodeURIComponent(executionId) + ".json";
  }

  async get(executionId: string): Promise<AnalyticsExecutionRecord | null> {
    const raw = await this.storage.get<string>(AnalyticsExecutionRepository.key(executionId));
    if (typeof raw !== "string") return null;
    try {
      const value: unknown = JSON.parse(raw);
      return validRecord(value) ? value : null;
    } catch {
      return null;
    }
  }

  async start(input: {
    executionId: string;
    eventKey: string;
    retryKey: string;
    workflowId: string;
    affectedTeamKeys: string[] | null;
    requestedAt: number;
    attempt: number;
    now?: number;
  }): Promise<AnalyticsExecutionRecord> {
    const previous = await this.get(input.executionId);
    const now = input.now ?? Date.now();
    const record: AnalyticsExecutionRecord = {
      execution_id: input.executionId,
      event_key: input.eventKey,
      retry_key: input.retryKey,
      workflow_id: input.workflowId,
      affected_team_keys: input.affectedTeamKeys,
      requested_at: input.requestedAt,
      started_at: previous?.started_at ?? now,
      updated_at: now,
      completed_at: null,
      attempt: Math.max(0, Math.min(MAX_ATTEMPTS, input.attempt)),
      status: "running",
    };
    await this.write(record);
    return record;
  }

  async retryScheduled(executionId: string, workflowId: string, now = Date.now()): Promise<void> {
    const current = await this.get(executionId);
    if (!current || current.status === "completed") return;
    await this.write({
      ...current,
      status: "retry_scheduled",
      retry_workflow_id: workflowId,
      next_retry_at: now,
      updated_at: now,
      completed_at: null,
    });
  }

  async complete(
    executionId: string,
    outcome: AnalyticsExecutionRecord["outcome"],
    sourceRevision?: number,
    now = Date.now(),
  ): Promise<void> {
    const current = await this.get(executionId);
    if (!current) return;
    await this.write({
      ...current,
      status: "completed",
      updated_at: now,
      completed_at: now,
      ...(Number.isSafeInteger(sourceRevision) ? { source_revision: sourceRevision } : {}),
      ...(outcome ? { outcome } : {}),
      retry_workflow_id: undefined,
      next_retry_at: undefined,
      error_class: undefined,
    });
  }

  async fail(executionId: string, error: unknown, now = Date.now()): Promise<void> {
    const current = await this.get(executionId);
    if (!current || current.status === "completed") return;
    const delay = current.attempt === 0 ? 5 * 60_000 : current.attempt === 1 ? 15 * 60_000 : undefined;
    await this.write({
      ...current,
      status: "failed",
      updated_at: now,
      completed_at: delay === undefined ? now : null,
      ...(delay === undefined ? {} : { next_retry_at: now + delay }),
      ...(delay === undefined ? { next_retry_at: undefined } : {}),
      error_class: error instanceof Error && error.name ? error.name.slice(0, 80) : "Error",
    });
  }

  async list(limit = 1000): Promise<AnalyticsExecutionRecord[]> {
    const records = await this.storage.list<string>({ prefix: PREFIX, limit: Math.max(1, Math.min(1000, limit)) });
    const parsed: AnalyticsExecutionRecord[] = [];
    for (const raw of records.values()) {
      if (typeof raw !== "string") continue;
      try {
        const value: unknown = JSON.parse(raw);
        if (validRecord(value)) parsed.push(value);
      } catch {
        // A malformed operational record is skipped; it cannot block bounded recovery.
      }
    }
    return parsed.sort((a, b) => a.updated_at - b.updated_at || a.execution_id.localeCompare(b.execution_id));
  }

  private async write(record: AnalyticsExecutionRecord): Promise<void> {
    await this.storage.put(AnalyticsExecutionRepository.key(record.execution_id), JSON.stringify(record));
  }
}
