# ADR-0009: District data ownership and acquisition

- **Status:** Accepted for the migration branch
- **Date:** 2026-11-20
- **Decision owners:** FieldView project

## Context

District data is shared across teams and events for a season. The canonical domain contract now represents a year-scoped district directory and per-district snapshots containing independently acquired district metadata, teams, events, rankings, and advancement. These resources do not have an independent realtime lifecycle comparable to an event or team aggregate.

Creating one Durable Object per district would add another fleet of independently scheduled objects and another source of write amplification. Duplicating district records into TeamRuntime would also violate ownership boundaries: a district's roster, events, rankings, and advancement are not team-owned resources.

The existing TaskScheduler is the global owner of season discovery and low-frequency scheduling. It is therefore the smallest existing durable owner capable of coordinating district discovery and refresh without introducing another Durable Object class.

## Decision

1. **TaskScheduler owns district acquisition and retained district resource representations.** It owns the year-scoped directory and district-key-scoped resources; it does not own or rewrite domain semantics.
2. **No DistrictRuntime Durable Object is introduced.** District resources are shared, season-scoped reference data, not an independently live aggregate.
3. **The Worker is the only provider-acquisition boundary.** It calls the provider-owned TBA endpoint builders/client, retains raw TBA representations and validators, and passes those records through the district domain normalizers. Next.js pages and API routes read canonical Worker snapshots only.
4. **Each resource has independent state and provenance.** Directory, district metadata, teams, events, rankings, and advancement must not share freshness. A successful fetch of one resource must not imply another is available.
5. **Use conditional requests and change-aware writes.** Retain ETags where supplied; on 304, update only the successful-check metadata when it actually changes. On 200, compare the new representation and provenance before writing. On failure, preserve the last usable representation and mark it stale; do not replace it with an empty array or null.
6. **Refresh at low frequency, not on page reads.** Public reads never trigger TBA acquisition. The global scheduler refreshes the current-season directory on its discovery cadence and schedules district resource refreshes at a conservative reference-data cadence. Resource work is bounded and resumable so it cannot monopolize the scheduler alarm or create request bursts.
7. **Historical district data is not bulk-ingested as part of this slice.** The initial directory and snapshots cover the current season used by the existing pages. Historical expansion requires a separate bounded backfill decision.
8. **CMP advancement remains a projection of canonical advancement.** The existing district and all-district CMP endpoints must derive their responses from retained canonical advancement data; they must not independently call TBA.

## Consequences

- District reads can be served from a single canonical source without adding another Durable Object class.
- District refresh and global event/team discovery share one scheduler owner, so provider request pacing and work budgeting must be explicit.
- The scheduler must retain resource-level state without rewriting unchanged payloads on every alarm. A refresh queue needs a stable cursor and bounded retry behavior.
- The web migration can remove legacy TBA service calls only after all directory, detail, advancement, and CMP routes read these Worker snapshots.
- If district resources later demonstrate an independent realtime lifecycle, coordination requirements, or materially different scaling needs, revisit this decision with measured evidence rather than pre-emptively creating another object.

## Implementation sequence

1. Add district directory/resource acquisition to TaskScheduler using TBA endpoint builders and bounded scheduler-owned work.
2. Persist independent resource payloads, validators, freshness, retry state, and a bounded refresh cursor; avoid writes when representations and scheduling state are unchanged.
3. Expose read-only Worker routes for the canonical district directory and per-district snapshot.
4. Add Worker-backed server snapshot helpers and migrate `/districts`, `/district/[district]`, district advancement, district CMP, and all-district CMP routes.
5. Add tests for 200/304/failure transitions, last-good retention, explicit unavailable versus empty, resource independence, bounded scheduling, and no-op writes.
6. Remove the legacy district TBA service usage only after every caller is migrated and parity is checked.
