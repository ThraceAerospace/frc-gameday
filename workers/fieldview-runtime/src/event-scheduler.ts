/** @deprecated Import TaskScheduler from "./task-scheduler.ts". */
export {
  TaskScheduler,
  TaskScheduler as EventScheduler,
  classifyEventLifecycle,
  eventPollingPolicy,
  DEFAULT_EVENT_POLLING_POLICY,
} from "./task-scheduler.ts";
export type {
  EventLifecycle,
  EventLifecycleDecision,
  EventPollingPolicy,
  EventWeekClassification,
} from "./task-scheduler.ts";
