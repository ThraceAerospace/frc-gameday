# ADR-0013: Data-bearing live publications and validator-backed client cache

> **Status: Superseded by ADR-0020 on 2026-11-27.** This document is retained only to record the earlier proposal. Do not implement its IndexedDB cache, persisted normalized-state publications, revision-gap HTTP recovery, or fetch-after-notify behavior.

- **Original status:** Accepted as an intermediate direction
- **Original date:** 2026-11-21
- **Superseded by:** [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md)

The earlier proposal correctly identified that realtime updates should carry committed FieldView data rather than merely announce that a revision changed. It also proposed a browser IndexedDB cache and conditional HTTP recovery.

ADR-0020 retains the data-bearing publication requirement but replaces the rest of that design:

- The browser obtains a canonical HTTP snapshot before opening the shared Multiplexer `/stream`.
- Event and team-event state changes carry the actual changed EventState snapshot or team-event patch/data, with identity and ordering/revision metadata.
- Analytics notifications carry the committed analytics publication.
- Revision-only invalidations are invalid.
- The SharedWorker cache is in-memory only; normalized snapshots are not persisted in IndexedDB.
- Notifications, sequence gaps, disconnects, and reconnects do not trigger HTTP snapshot or analytics refetches. Reconnect restores subscriptions only.
- EventState and TeamState are ephemeral read projections derived from durable provider endpoint records, not persisted canonical publications.

The data-bearing message requirement is normative and is defined in [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md).
