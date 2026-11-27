# ADR-0009: District data ownership and acquisition

- **Status:** Accepted
- **Date:** 2026-11-19
- **Scope:** Domain ownership and provider acquisition

## Decision

FieldView does not maintain a district-owned canonical aggregate or independent district runtime. TeamRuntime and EventRuntime retain district membership and district-point facts that are part of their respective team/event provider resources.

There is no district Durable Object, directory, snapshot, acquisition lifecycle, canonical district query surface, or district-specific product page in the current product scope.

Provider data remains owned by the runtime whose scope contains the resource. Team and event records may reference a district identifier and retain the provider fields needed for their own views; neither runtime writes a separate district canonical record.

## Consequences

- District membership is available through team/event state without creating a third runtime type.
- Provider acquisition remains within EventRuntime/TeamRuntime ownership after the one-time first-registration bootstrap defined by ADR-0020.
- Season discovery and runtime initialization are coordinated by Workflows. The polling coordinator dispatches ongoing refresh commands; there is no TaskScheduler Durable Object.
- A future district product capability requires a separately approved domain model, ownership boundary, API contract, and acquisition policy.

See [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md) for provider acquisition and runtime initialization rules.
