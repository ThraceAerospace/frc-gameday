declare module "cloudflare:workers" {
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected readonly env: Env;
    constructor(ctx: ExecutionContext, env: Env);
  }

  export interface WorkflowEvent<Params> {
    payload: Readonly<Params>;
    instanceId: string;
    workflowName: string;
    timestamp: Date;
    schedule?: { cron: string; scheduledTime: number };
  }

  export interface WorkflowStep {
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
    sleep(name: string, duration: string): Promise<void>;
  }
}

interface ExecutionContext {}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface WorkflowInstance {
  status(): Promise<{ status: string }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
}

interface Workflow {
  create(options: { id: string; params: unknown }): Promise<unknown>;
  get(id: string): Promise<WorkflowInstance>;
}
