# Season discovery and runtime initialization

## Ownership

Season discovery and runtime initialization are Workflow responsibilities. EventRuntime and TeamRuntime own their provider endpoint records and, after initial bootstrap, all ongoing provider acquisition. Workflows coordinate registration and first-time hydration but do not create normalized client projections.

## Discovery

The season status resolver obtains TBA's canonical current-season value and persists the validated pointer. Discovery Workflows acquire the season event directory and paginated team directory, validate provider responses, and publish canonical discovery records through the D1 discovery repository.

Event and team directories are discovery data. They are not EventState/TeamState snapshots and do not imply that every listed entity has a registered runtime.

## First-registration bootstrap

EventSeasonReadinessWorkflow and TeamSeasonReadinessWorkflow perform the explicit initialization lifecycle for their respective scopes:

1. Read the completed season discovery directory.
2. Register the EventRuntime or TeamRuntime identity if it does not yet exist.
3. Determine whether the runtime requires its initial provider endpoint resources.
4. For a newly registered runtime, perform the one-time bounded provider acquisition permitted by ADR-0020.
5. Import the acquired endpoint records and acquisition metadata into the owning Durable Object.
6. Record per-entity initialization and resource outcomes in System Records for operational inspection.

This bootstrap is an intentional first-creation exception retained to solve unreliable initial runtime hydration. It is idempotent and bounded. It stores provider endpoint responses, validators, freshness, status, and revisions only. It does not generate or persist EventState or TeamState. It must not become a recurring refresh mechanism for initialized runtimes.

## Ongoing refresh

After initialization, the owning EventRuntime or TeamRuntime performs every provider request for its scope. The Worker-level polling coordinator selects resources due for refresh according to event/team lifecycle policy and dispatches explicit refresh commands with bounded concurrency and provider request spacing. The target runtime performs acquisition, conditional requests, reconciliation, persistence, and publication.

Workflows may orchestrate durable multi-step operations and record their outcomes, but they do not proxy ongoing provider requests. No Queue consumer, per-runtime polling queue, or Durable Object alarm is used.

## Read contract

A client read requests EventState or TeamState. The owning Durable Object constructs the normalized projection from its stored provider endpoint records. Projection caches are optional and disposable; reads do not write storage, fetch providers, register runtimes, or schedule work.

## Failure behavior

- Missing resources remain missing and are reported as such.
- Failed refreshes preserve last-good endpoint payloads.
- HTTP 304 preserves the existing payload and does not create a new payload revision.
- Partial bootstrap is recorded as partial resource coverage; it does not create a persisted normalized state publication.
- A retry uses stable initialization identity and must not overwrite newer runtime data or regress revisions.
- Failure for one provider endpoint does not erase unrelated valid endpoint records.

## Integration gate

Validate discovery completeness, team pagination, registration, one-time bootstrap, retry idempotency, ongoing runtime-owned refresh, partial/failure handling, read-time projections, cache eviction, and zero-write snapshot reads in an isolated Preview/local integration environment before production cutover.
