# ADR-0018: Sequential readiness sweeps

> **Status: Superseded by [ADR-0020](decisions/ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md) on 2026-11-27.** Its publication-gated read model and persisted-projection requirements are no longer valid. This file is retained only as decision history.

- **Original status:** Partially superseded
- **Original date:** 2026-11-22

This decision originally addressed season-scale readiness work, runtime registration, and the risk of a large burst of Durable Object alarm-driven provider requests.

The durable principles that remain are:
- Public reads must not become implicit initialization or refresh commands.
- Runtime initialization and ongoing refresh are explicit operations.
- The polling coordinator, not per-runtime alarms, owns lifecycle scheduling and bounded refresh dispatch.
- EventRuntime and TeamRuntime own ongoing provider acquisition for their respective scopes.
- Readiness/initialization workflows are durable orchestration and must expose per-entity outcomes.

The original requirements that reads wait for persisted normalized-state publications, that projections must exist before a snapshot can be served, and that a published EventState/TeamState is the canonical read source are superseded. Under ADR-0020, provider endpoint records are durable; EventState and TeamState are derived at read time and are never persisted as canonical state.

ADR-0020 also clarifies the one-time first-registration bootstrap exception: an initialization Workflow may acquire the initial provider endpoint resources to reliably hydrate a newly created runtime. That operation is distinct from recurring provider refresh, which belongs to the owning runtime.

See [ADR-0020](decisions/ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md), [runtime lifecycle](../development/FIELDVIEW-RUNTIME.md), and [production integration gate](MIGRATION-PLAN.md) for current requirements.
