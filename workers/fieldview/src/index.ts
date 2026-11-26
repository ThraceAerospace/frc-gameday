import runtimeWorker from "./runtime/index.ts";
import jobsWorker from "./jobs/index.ts";
import type { RuntimeEnvironment } from "./runtime/cloudflare.ts";

type RuntimeContext = Parameters<typeof runtimeWorker.fetch>[2];
type JobsEnvironment = Parameters<typeof jobsWorker.fetch>[1];
type RuntimeWorkerEnvironment = RuntimeEnvironment & JobsEnvironment;

/**
 * Single deployment boundary for Runtime and Jobs.
 *
 * Jobs is invoked through a local module callback. No Worker service binding
 * or self-service binding is involved; Workflows use the shared DO namespaces
 * directly through runtime-dispatch.ts and discovery-service.ts.
 */
export default {
  scheduled(controller: { scheduledTime: number; cron?: string }, env: RuntimeWorkerEnvironment, context: { waitUntil(promise: Promise<unknown>): void }): void {
    const scheduledAt = controller.scheduledTime;
    if (controller.cron === "0 16 * * 1") {
      if (!env.WEEKLY_EVENT_PROJECTION) {
        console.warn("[DISCOVERY] Weekly event projection Workflow binding is not configured");
        return;
      }
      const workflowId = "events-this-week-" + scheduledAt;
      context.waitUntil(env.WEEKLY_EVENT_PROJECTION.create({
        id: workflowId,
        params: { requestedAt: scheduledAt, reason: "scheduled" },
      }).then(() => {
        console.log("[DISCOVERY] Weekly event projection accepted", JSON.stringify({ workflow_id: workflowId, scheduled_at: scheduledAt }));
      }).catch((error) => {
        console.error("[DISCOVERY] Weekly event projection could not be started", JSON.stringify({
          workflow_id: workflowId, scheduled_at: scheduledAt, error: error instanceof Error ? error.message : String(error),
        }));
      }));
      return;
    }
    if (!env.POLLING_COORDINATOR) {
      console.warn("[POLLING] Coordinator binding is not configured in this environment");
      return;
    }
    const workflowId = "polling-" + scheduledAt;
    context.waitUntil(env.POLLING_COORDINATOR.create({
      id: workflowId,
      params: { scheduledAt, pollTeams: controller.cron === "2 4 * * *" },
    }).then(() => {
      console.log("[POLLING] Coordinator workflow accepted", JSON.stringify({ workflow_id: workflowId, scheduled_at: scheduledAt }));
    }).catch((error) => {
      console.error("[POLLING] Coordinator workflow could not be started", JSON.stringify({
        workflow_id: workflowId, scheduled_at: scheduledAt, error: error instanceof Error ? error.message : String(error),
      }));
    }));
  },
  fetch(request: Request, env: RuntimeWorkerEnvironment, context: RuntimeContext): Promise<Response> {
    const runtimeEnv: RuntimeEnvironment = {
      ...env,
      JOBS_REQUEST: (jobsRequest) => jobsWorker.fetch(jobsRequest, env),
    };
    return runtimeWorker.fetch(request, runtimeEnv, context);
  },
};

export { EventRuntime, TeamRuntime, Multiplexer } from "./runtime/index.ts";
export { DailyEventReadinessWorkflow, DailyTeamReadinessWorkflow, CoverageAuditWorkflow, RuntimeAdminWorkflow, PollingCoordinatorWorkflow, WeeklyEventProjectionWorkflow, EventAnalyticsWorkflow } from "./jobs/index.ts";
