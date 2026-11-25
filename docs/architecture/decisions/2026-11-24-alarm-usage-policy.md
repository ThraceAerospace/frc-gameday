# Durable Object Alarm Policy

- **Status:** Accepted
- **Date:** 2026-11-24
- **Scope:** All FieldView Durable Objects
- **Owner direction:** Durable Objects must not schedule or execute polling.

## Decision

FieldView Durable Objects must not use alarms for any purpose. In particular, they must not use alarms or alarm-backed queues for:

- Recurring provider polling.
- Manual or demand-driven deferred provider refreshes.
- Provider retry loops or delayed authoritative refetches.
- Event lifecycle scheduling.
- Event or team analytics scheduling/retries.
- Any other recurring or deferred background work.

There are no application-defined alarm handlers and no application calls to `setAlarm()` or `deleteAlarm()`. Alarm scheduling and delivery are left entirely to the platform defaults; FieldView does not use this facility.

## Ownership

- **Worker-level coordinator:** owns refresh eligibility, timing, target selection, overlap prevention, bounded concurrency, prioritization, retries, and aggregate operation budgets. It sends explicit refresh commands.
- **EventRuntime / TeamRuntime:** own direct provider acquisition when explicitly commanded, validators, reconciliation, canonical state, persistence, and scope-specific calculations/publications.
- **Workflows:** own explicitly initiated durable multi-step jobs and deliberate waits where needed. They must not become an always-running replacement polling loop.
- **Durable Object alarms:** prohibited.

A runtime may acquire its own resources after an explicit refresh command. That capability does not grant it authority to decide when to poll, create a recurring schedule, enqueue deferred polling, or retry itself later.

## Required behavior

1. Public GET/read paths never schedule provider work.
2. Lifecycle and activity updates may persist state used by the coordinator, but never create local polling schedules.
3. Webhooks may persist canonical updates or invalidation markers, but never schedule follow-up provider fetches.
4. Failed refreshes preserve last-good state. A later coordinator pass or explicit command decides whether to retry.
5. Analytics may be recalculated during an explicit refresh/command, but must not be queued behind a DO alarm.
6. No code path in a Durable Object calls `setAlarm`.
7. Do not add an `alarm()` handler or attempt to inspect, cancel, or clean up legacy alarm state.

## Migration note

This intentionally removes the legacy EventRuntime and TeamRuntime alarm polling engines and their scheduling entry points. The application does not register alarm handlers or perform alarm cleanup. Automatic polling and deferred alarm-driven analytics may remain unavailable until the Worker-level coordinator explicitly dispatches the required refresh commands. That breakage is intentional; it is preferable to continuing uncontrolled Durable Object quota consumption.
