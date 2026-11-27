# Durable Object Read/Write Contract Audit

**Status:** Current contract for final integration testing  
**Branch:** `fieldview-architecture-migration`  
**Deployment:** No branch resources have been deployed.

## Authoritative storage

EventRuntime and TeamRuntime persist provider endpoint records, including payloads, validators, freshness metadata, status, and revisions. EventState and TeamState are normalized read projections. Optional matching projections may be used as caches, but endpoint records are always authoritative.

## Read-only operations

The following operations must not call Durable Object storage `put` or `delete`, schedule alarms, or trigger provider acquisition:

- Event snapshot and event view reads.
- Team snapshot reads.
- Event/team readiness inspection.
- Event/team discovery reads.
- Analytics orchestration input reads.
- Published analytics reads.
- Runtime state/diagnostic reads.
- Multiplexer subscription reads and canonical snapshot recovery.

Projection construction may read endpoint records and build objects in memory. A cache miss or DO eviction must not create a persistent projection.

## Explicit write operations

Writes are limited to:
- registering a runtime identity;
- bootstrap/import of provider endpoint records;
- provider polling and 304/failure metadata reconciliation;
- authenticated TBA webhook reconciliation;
- explicit analytics result publication and acknowledgement;
- explicit discovery/system-record Workflow mutations;
- remote-session WebSocket acceptance/attachment lifecycle (no periodic storage writes).

## Scheduling contract

The Worker cron handler starts Workflows. The polling coordinator chooses due resources and dispatches explicit refresh commands. No Durable Object alarm handler, alarm-backed polling loop, legacy task queue, or Cloudflare Queue consumer is part of the target.

## Integration-test assertions

1. First event snapshot read with provider endpoint records present creates a normalized EventState response without a storage write.
2. Repeated snapshot reads use a matching hot cache or rebuild from endpoint records, still without a storage write.
3. A new Durable Object instance with the same endpoint records can produce the same normalized response after cache eviction.
4. Team snapshot reads obey the same invariants.
5. Missing endpoint records return an incomplete/missing-resource response; they do not trigger provider I/O or synthesize readiness.
6. Explicit bootstrap/refresh writes endpoint records and changes the source signature.
7. A 304 preserves payload and advances only the appropriate freshness/attempt metadata.
8. Failed refresh preserves last-good payload and surfaces stale/failure metadata.
9. Webhook reconciliation updates only affected endpoint resources and publishes a scoped revision.
10. Analytics publication and TeamRuntime acknowledgement are revision-checked and recover through Workflow retries.

## Cost guardrails

Durable Object row writes must correspond to explicit state mutations, not reads, cache hydration, diagnostics, or subscription registration. Validate row-write counts in Preview before production deployment.
