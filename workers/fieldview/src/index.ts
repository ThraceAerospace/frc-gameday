import runtimeWorker from "../../fieldview-runtime/src/index.ts";
import jobsWorker from "../../fieldview-jobs/src/index.ts";
import type { RuntimeEnvironment } from "../../fieldview-runtime/src/cloudflare.ts";

type RuntimeContext = Parameters<typeof runtimeWorker.fetch>[2];
type JobsEnvironment = Parameters<typeof jobsWorker.fetch>[1];
type FieldViewEnvironment = RuntimeEnvironment & JobsEnvironment;

/**
 * Single deployment boundary for Runtime and Jobs.
 *
 * Jobs is invoked through a local module callback. No Worker service binding
 * or self-service binding is involved; Workflows use the shared DO namespaces
 * directly through runtime-dispatch.ts and discovery-store.ts.
 */
export default {
  fetch(request: Request, env: FieldViewEnvironment, context: RuntimeContext): Promise<Response> {
    const runtimeEnv: RuntimeEnvironment = {
      ...env,
      JOBS_REQUEST: (jobsRequest) => jobsWorker.fetch(jobsRequest, env),
    };
    return runtimeWorker.fetch(request, runtimeEnv, context);
  },
};

export { EventRuntime, TeamRuntime, Multiplexer, DiscoveryStore } from "../../fieldview-runtime/src/index.ts";
export { DailyEventReadinessWorkflow, DailyTeamReadinessWorkflow, CoverageAuditWorkflow, RuntimeAdminWorkflow } from "../../fieldview-jobs/src/index.ts";
