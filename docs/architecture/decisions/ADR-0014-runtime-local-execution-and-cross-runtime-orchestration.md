# ADR-0014: Runtime-local execution and cross-runtime orchestration

> **Status: Superseded.** The current runtime and orchestration contract is defined by [the 2026-11-24 storage and polling decision](2026-11-24-storage-and-polling-ownership.md), [ADR-0019](../ADR-0019-single-worker-with-branch-previews.md), and [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md). This summary is retained for decision history only.

- **Original date:** 2026-11-21
- **Original scope:** EventRuntime, TeamRuntime, TaskScheduler, and Worker orchestration

The original proposal introduced runtime-local durable task queues and alarm scheduling, with a global TaskScheduler Durable Object coordinating cross-runtime work. That model was replaced by a consolidated Worker with a Worker-level polling coordinator and Cloudflare Workflows.

The following current rules supersede the original design:

- EventRuntime and TeamRuntime are separate canonical ownership boundaries implementing the same runtime lifecycle at different scopes.
- Each runtime owns its ongoing provider acquisition, validators, reconciliation, persistence, freshness, retries, and data-bearing publication.
- A one-time initialization Workflow may acquire initial provider endpoint resources when a runtime is first registered/created, to ensure reliable hydration. This is the only Workflow-owned provider acquisition exception; it is bounded, idempotent, and does not create EventState/TeamState.
- After bootstrap, Workflows orchestrate durable multi-step operations; the polling coordinator selects due runtimes and dispatches explicit refresh commands. It does not fetch provider data.
- Durable Object alarms are not used for polling. There is no TaskScheduler Durable Object, per-runtime queue, or Queue compatibility path.
- Public reads are side-effect-free and derive ephemeral EventState/TeamState projections from durable provider endpoint records.
- Cross-runtime work uses explicit versioned interfaces and references. One runtime does not persist another runtime's canonical aggregate.
- One environment-neutral Worker named `runtime` serves Production and branch Previews under one Wrangler configuration.

No implementation should be added from the superseded queue/alarm or TaskScheduler portions of this historical proposal.
