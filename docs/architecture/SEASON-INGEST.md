# Season Discovery and Resource Bootstrap

## Ownership

Season discovery and runtime bootstrap are Workflow responsibilities. EventRuntime and TeamRuntime own their provider endpoint records; the Workflows coordinate acquisition and import, but do not create normalized client projections.

## Discovery

The season status resolver obtains TBA's canonical current-season value and persists the validated pointer. Discovery Workflows acquire the season's event directory and paginated team directory, validate provider responses, and publish canonical discovery records through the discovery repository.

Event and team directories are discovery data, not EventState/TeamState snapshots.

## Readiness and bootstrap

EventSeasonReadinessWorkflow and TeamSeasonReadinessWorkflow:
1. Read the completed season discovery directory.
2. Ensure the corresponding EventRuntime/TeamRuntime identities are registered.
3. Inspect provider endpoint-resource readiness.
4. Acquire missing endpoint resources through the shared provider adapters.
5. Import the resource bundle into the matching Durable Object.
6. Record per-entity resource acquisition outcomes for the admin dashboard.

Bootstrap stores only provider endpoint data and its acquisition metadata. It does not call a projection-publication route and does not require EventState or TeamState to exist.

## Ongoing refresh

The Worker-level polling coordinator selects resources due for refresh according to event/team lifecycle policy. It dispatches explicit refresh commands with bounded concurrency and provider request spacing. Workflows own retries and operational records. No Queue consumer, per-runtime polling queue, or Durable Object alarm is used.

## Read contract

A client read requests EventState or TeamState. The Durable Object constructs the normalized projection from its stored endpoint records. Projection caches are optional and disposable; reads do not write storage or fetch providers.

## Failure behavior

- Missing resources remain missing and are reported as such.
- Failed refreshes preserve last-good endpoint payloads.
- 304 responses preserve the existing payload and update freshness metadata.
- Partial bootstrap is reported as a partial resource set; it does not publish an incomplete normalized state as if fully initialized.
- A Workflow retry reuses the stable acquisition identity and does not regress newer webhook/poll records.

## Final integration validation

Validate season discovery, complete team pagination, event/team identity registration, endpoint bootstrap, partial/failure handling, retry idempotency, read-time projections, cache eviction, and zero-write read behavior in an isolated Cloudflare Preview before merge.
