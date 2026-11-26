/** Minimal structural Cloudflare runtime contracts used by this worker. */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  /** Executes the supplied statements as one atomic D1 batch transaction. */
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}
export interface KVNamespaceLike {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface DurableObjectTransactionLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  list<T = unknown>(options?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>;
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
  /** Cloudflare's activation barrier; used only for bounded local storage hydration/recovery. */
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
  /** Cloudflare Durable Object WebSocket hibernation APIs. */
  acceptWebSocket?(socket: WebSocket): void;
  getWebSockets?(): WebSocket[];
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface RuntimeEnvironment {
  /** Static administrator SPA assets, served only after Worker-side Access verification. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Environment-specific D1 database (production or Preview test database). */
  DB?: D1DatabaseLike;
  /** Injectable record adapter for isolated runtime tests; production uses DB. */
  DISCOVERY_STORAGE?: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    list<T = unknown>(options?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>;
    delete(key: string): Promise<boolean>;
  };
  /** Environment-specific KV namespace for non-authoritative projections. */
  KV_BINDING?: KVNamespaceLike;
  TBA_API_KEY: string;
  /** Official Statbotics API when available; currently the configured testing mirror is retained while official service is unavailable. */
  STATBOTICS_API_BASE_URL?: string;
  /** Delay for the one-shot authoritative TBA REST refetch after a webhook (default 65000 ms). */
  TBA_AUTHORITATIVE_REFETCH_DELAY_MS?: string | number;
  /** Debounced one-shot Statbotics refresh after accepted TBA representation changes. */
  STATBOTICS_REFRESH_DELAY_MS?: string | number;
  TBA_WEBHOOK_SECRET: string;
  /** Service-to-service credential; never expose this to browser clients. */
  RUNTIME_ADMIN_TOKEN: string;
  /** Cloudflare Access team issuer and this application's audience tag. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  /** Comma-, semicolon-, or whitespace-separated exact administrator email allowlist. */
  RUNTIME_ADMIN_EMAILS?: string;
  EVENT_RUNTIME: DurableObjectNamespaceLike;
  TEAM_REFRESH_INTERVAL_MS?: string | number;
  TEAM_ACTIVE_REFRESH_INTERVAL_MS?: string | number;
  TEAM_RUNTIME?: DurableObjectNamespaceLike;
  MULTIPLEXER?: DurableObjectNamespaceLike;
  /** Production-only Workflow binding; omitted from branch Preview configuration. */
  EVENT_ANALYTICS_WORKFLOW?: Workflow;
  /** In-process module interface used by the consolidated Worker entrypoint. */
  JOBS_REQUEST?: (request: Request) => Promise<Response>;
  EVENT_ACTIVE_INTERVAL_MS?: string | number;
  EVENT_COMPLETED_RETENTION_MS?: string | number;
  /** Test seam; production uses the Workers global fetch implementation. */
  fetcher?: typeof fetch;
  /** Test seams for the Cloudflare WebSocket upgrade API. */
  webSocketPairFactory?: () => [WebSocket, WebSocket];
  webSocketResponseFactory?: (client: WebSocket) => Response;
}
