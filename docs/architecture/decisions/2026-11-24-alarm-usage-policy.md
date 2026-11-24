# Durable Object Alarm Usage Policy

- **Status:** Accepted
- **Date:** 2026-11-24
- **Scope:** EventRuntime, TeamRuntime, and future FieldView Durable Objects
- **Owner direction:** Alarms are a last-resort recovery primitive, not a normal scheduler.

## Decision

FieldView must not use Durable Object alarms for recurring provider polling, routine refresh queues, analytics scheduling, or ordinary retry loops. Those responsibilities belong to the explicit coordinator and its bounded refresh commands, or to a Cloudflare Workflow when durable multi-step orchestration or a deliberate wait is required.

A runtime may set an alarm only when all of the following are true:

1. The work is genuinely time-delayed and cannot be completed in the current request or represented as an explicit coordinator command.
2. A Workflow is not a better owner for the required durable wait/retry lifecycle.
3. Losing the alarm would leave a recoverability gap that cannot be repaired by the next coordinator pass, webhook, or explicit admin action.
4. The alarm is one-shot, bounded, and documented with its exact purpose, key namespace, expected frequency, retry policy, and cleanup behavior.
5. The alarm does not run a recurring provider-poll loop or silently create additional work from public reads.

If no qualifying use exists, the Durable Object must have no alarm scheduled. Alarm handlers are not to be retained as dormant polling engines.

## Ownership

- **Coordinator:** owns event/team lifecycle eligibility, target selection, overlap prevention, bounded concurrency, prioritization, and aggregate provider-operation/storage budgets. It issues explicit refresh commands; it does not fetch provider data or reconcile runtime state.
- **EventRuntime / TeamRuntime:** own provider acquisition, validators, reconciliation, canonical state, persistence, and their own calculations/publications. A refresh command performs that work synchronously within bounded request limits.
- **Workflows:** own durable multi-step jobs, explicit waits, bounded batches, and retryable administrative/discovery operations. Workflow execution must be initiated intentionally; do not replace one always-running alarm loop with an always-running Workflow loop.
- **Alarms:** last-resort one-shot recovery only, subject to the criteria above.

## Required behavior

- Public GET/read paths remain side-effect-free and must never schedule an alarm or enqueue hidden provider work.
- Ordinary refresh requests use explicit runtime refresh commands and return truthful outcomes.
- A failed provider refresh preserves last-good canonical state. Retry is initiated by a later coordinator pass, an explicit retry command, or a narrowly justified Workflow—not by a permanent per-runtime alarm loop.
- HTTP 304 remains a strict no-op for canonical data and publication revisions.
- Runtime state must remain recoverable after Worker/DO restart without requiring a continuously armed alarm.
- Every alarm introduction or retained alarm requires a corresponding decision-record update and a test proving its bounded one-shot behavior.

## Current migration implications

The current EventRuntime and TeamRuntime alarm handlers still execute recurring provider polling, queued refresh retries, deferred analytics, and lifecycle cleanup. These are legacy mechanisms and conflict with this policy. Remove those responsibilities and their queue/task storage paths as the coordinator and explicit refresh contract are completed. Do not simply disable setAlarm while leaving queued work silently accumulating.

The existing delayed post-webhook authoritative TBA refetch, TeamRuntime-to-EventRuntime invalidation, and deferred analytics work must each receive an explicit replacement or be intentionally removed with the corresponding behavior documented. They must not be assumed to be interchangeable.

## Quota and operational visibility

The coordinator must expose enough counters to calculate provider requests, runtime dispatches, Workflow instances/steps, and any exceptional alarm invocations by environment and time window. Do not infer quota savings from deleting code; verify actual account usage before deployment. No recurring alarm is permitted merely to keep runtimes warm or continuously active.