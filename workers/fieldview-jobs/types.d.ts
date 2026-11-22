declare module "cloudflare:workers" {
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected readonly env: Env;
    constructor(ctx: ExecutionContext, env: Env);
  }
}

interface WorkflowEvent<Params> {
  payload: Params;
  instanceId: string;
  timestamp: string;
}

interface WorkflowStep {
  do<Result>(name: string, callback: () => Promise<Result>): Promise<Result>;
  do<Result>(
    name: string,
    options: {
      retries?: {
        limit?: number;
        delay?: string;
        backoff?: "constant" | "linear" | "exponential";
      };
    },
    callback: () => Promise<Result>,
  ): Promise<Result>;
}

interface R2ObjectBody {
  json<Result = unknown>(): Promise<Result>;
  text(): Promise<string>;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Workflow {
  create(options: { id: string; params: unknown }): Promise<unknown>;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}
