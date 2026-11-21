/** Minimal structural Cloudflare runtime contracts used by this worker. */
export interface DurableObjectTransactionLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm?(): Promise<number | null>;
}

export interface DurableObjectStorageLike extends DurableObjectTransactionLike {
  transaction<T>(callback: (transaction: DurableObjectTransactionLike) => Promise<T>): Promise<T>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  /** Cloudflare Durable Object WebSocket hibernation APIs. */
  acceptWebSocket?(socket: WebSocket): void;
  getWebSockets?(): WebSocket[];
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface RuntimeEnvironment {
  TBA_API_KEY: string;
  /** Approved official or FieldView-operated compatible Statbotics API base URL. */
  STATBOTICS_API_BASE_URL?: string;
  /** Delay for the one-shot authoritative TBA REST refetch after a webhook (default 65000 ms). */
  TBA_AUTHORITATIVE_REFETCH_DELAY_MS?: string | number;
  /** Debounced one-shot Statbotics refresh after accepted TBA representation changes. */
  STATBOTICS_REFRESH_DELAY_MS?: string | number;
  TBA_WEBHOOK_SECRET: string;
  RUNTIME_ADMIN_TOKEN: string;
  EVENT_RUNTIME: DurableObjectNamespaceLike;
  TEAM_REFRESH_INTERVAL_MS?: string | number;
  TEAM_ACTIVE_REFRESH_INTERVAL_MS?: string | number;
  TEAM_RUNTIME?: DurableObjectNamespaceLike;
  MULTIPLEXER?: DurableObjectNamespaceLike;
  TASK_SCHEDULER?: DurableObjectNamespaceLike;
  EVENT_DISCOVERY_INTERVAL_MS?: string | number;
  EVENT_UPCOMING_INTERVAL_MS?: string | number;
  EVENT_ACTIVE_INTERVAL_MS?: string | number;
  EVENT_COMPLETED_RETENTION_MS?: string | number;
  /** Legacy pacing for bounded administrative ingestion only; never gates runtime requests. */
  PROVIDER_REQUEST_INTERVAL_MS?: string | number;
  /** Test seam; production uses the Workers global fetch implementation. */
  fetcher?: typeof fetch;
  /** Test seams for the Cloudflare WebSocket upgrade API. */
  webSocketPairFactory?: () => [WebSocket, WebSocket];
  webSocketResponseFactory?: (client: WebSocket) => Response;
}
