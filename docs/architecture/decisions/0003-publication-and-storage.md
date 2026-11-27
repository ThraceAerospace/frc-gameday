# ADR 0003: Event publication protocol and persistence boundary

> **Status: Superseded and resolved by ADR-0020 on 2026-11-27.** This document records the questions considered before the final publication and storage contract was accepted. It is not an open design proposal.

- **Original status:** Proposed
- **Original date:** 2026-11-16
- **Resolution:** [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md)

## Resolved publication contract

- The browser obtains a canonical HTTP EventState or TeamState snapshot first.
- It then subscribes through the single Multiplexer-owned `/stream` WebSocket.
- Event state updates carry the changed EventState snapshot data.
- Team-event updates carry the changed team-event patch/data and its owning scope.
- Analytics updates carry the committed analytics publication.
- Messages include resource identity and ordering/revision metadata.
- Revision-only invalidations are invalid.
- Notifications, sequence gaps, disconnects, and reconnects never trigger hidden HTTP refetches. Reconnect restores subscriptions only.

## Resolved persistence contract

- EventRuntime and TeamRuntime persist provider endpoint responses and their validators/acquisition metadata.
- EventState and TeamState are ephemeral normalized read projections derived from those records.
- A projection may be cached in disposable Durable Object memory, but is not persisted as canonical state.
- Snapshot reads do not fetch providers, schedule work, register runtimes, or write Durable Object storage.
- First-registration initialization Workflows may perform a one-time bounded provider acquisition to hydrate a new runtime. Bootstrap stores endpoint records only; ongoing acquisition belongs to the owning runtime.
- Analytics publications remain separately persisted, scope-owned outputs with their own revisions and provenance.

## Consequences

The initial HTTP snapshot provides the client's starting revision. Subsequent realtime messages carry actual changed data, so the SharedWorker can apply updates without a second HTTP request. Provider endpoint records remain the durable source of truth; normalized state is derived when needed.

See ADR-0020 for the complete normative design.
