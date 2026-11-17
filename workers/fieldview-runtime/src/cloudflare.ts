/** Minimal structural Cloudflare runtime contracts used by this worker. */
export interface DurableObjectTransactionLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DurableObjectStorageLike extends DurableObjectTransactionLike {
  transaction<T>(callback: (transaction: DurableObjectTransactionLike) => Promise<T>): Promise<T>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface RuntimeEnvironment {
  TBA_API_KEY: string;
  TBA_WEBHOOK_SECRET: string;
  RUNTIME_ADMIN_TOKEN: string;
  EVENT_RUNTIME: DurableObjectNamespaceLike;
  /** Test seam; production uses the Workers global fetch implementation. */
  fetcher?: typeof fetch;
}
