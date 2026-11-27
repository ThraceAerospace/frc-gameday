# ADR-0015: Persistence equals readiness

> **Status: Superseded by ADR-0020 on 2026-11-27.** This record is retained as a concise history of the earlier persisted-publication model. None of its publication-gated read, read-triggered refresh, alarm, local queue, or TaskScheduler requirements remain current.

- **Original status:** Accepted
- **Original date:** 2026-11-21
- **Superseded by:** [ADR-0018](../ADR-0018-sequential-readiness-sweeps.md), then [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md)

The original decision treated persisted normalized EventState/TeamState publications as the readiness boundary and described stale-while-revalidate reads backed by runtime-local queues and alarms. Those mechanisms were superseded.

The current contract is:
- EventRuntime and TeamRuntime persist provider endpoint records and their acquisition metadata.
- EventState and TeamState are ephemeral normalized projections derived from those records when requested.
- Snapshot reads are read-only and do not initialize, refresh, schedule, or write.
- A first-registration Workflow may perform a one-time, bounded provider acquisition to reliably hydrate a newly created runtime. It stores endpoint records only.
- After bootstrap, ongoing provider acquisition belongs to the owning runtime and is initiated by explicit refresh commands from the polling coordinator or approved operations.
- Durable Object alarms are not used for polling.
- Realtime follows snapshot-first ordering and sends data-bearing notifications; notifications and reconnects do not trigger HTTP refetches.

The historical decision's broader goal—preserving last-good provider data across failures—remains valid. A failed or partial acquisition must not erase unrelated valid endpoint records.

See [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md) for the normative design.
