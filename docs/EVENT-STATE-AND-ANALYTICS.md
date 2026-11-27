# EventState and Analytics

## Canonical data model

EventRuntime and TeamRuntime store provider endpoint responses as independent durable resources, along with validators, freshness metadata, revisions, and acquisition status.

- **EventState** is the normalized event-scoped client read model derived by EventRuntime.
- **TeamState** is the normalized team-season client read model derived by TeamRuntime.
- **TeamEventState** is the team/event-scoped analytics input/result contract owned by TeamRuntime. It is not embedded into EventState.
- **EventAnalytics** is the event-owned analytics publication produced by the analytics Workflow and published by EventRuntime.

These models have distinct ownership and must not be used as substitutes for provider endpoint records.

## Read lifecycle

1. The client requests an event or team snapshot from the Runtime Worker.
2. EventRuntime/TeamRuntime read the relevant endpoint records.
3. A matching hot in-memory projection may be reused.
4. If no matching projection exists, the Durable Object constructs an ephemeral normalized projection from the endpoint records.
5. The Worker returns the normalized FieldView contract with its revision, validator, and source metadata.

Projection materialization is disposable. DO eviction is expected and must not affect correctness. A projection may optionally be persisted as a fast path, but reads must never assume it exists. A cold read must not write storage, refresh providers, schedule work, or create a readiness record.

## Write lifecycle

Only explicit acquisition or reconciliation operations write provider endpoint records:
- initial bootstrap from readiness Workflows;
- coordinator-dispatched provider refresh;
- authenticated TBA webhook reconciliation;
- explicit admin refresh commands.

A 304 response updates endpoint freshness/attempt metadata according to the endpoint-state contract without replacing the last-good payload. Failed refreshes preserve last-good data and update failure metadata. Reads surface available stale data with source metadata rather than triggering hidden provider work.

## Analytics lifecycle

EventAnalyticsWorkflow coordinates cross-runtime calculations:
1. Read versioned EventRuntime analytics inputs.
2. Resolve registered TeamRuntime owners.
3. Ask TeamRuntime to prepare versioned season/event analytics inputs.
4. Calculate team/event analytics using the shared analytics package.
5. Publish the aggregate to EventRuntime.
6. Acknowledge TeamRuntime results only after successful EventRuntime publication.

Revision checks reject stale inputs and prevent publication regression. Workflow retries recover failed publication/acknowledgement steps. Analytics GET routes read the last publication; they do not start calculations.

## Realtime lifecycle

The browser obtains the initial snapshot through the Runtime Worker and then subscribes to `/stream`. The origin-wide SharedWorker owns one stream connection and fans canonical snapshot/analytics updates to tabs. On reconnect, it re-registers subscriptions and performs conditional snapshot recovery. It does not acquire provider resources, maintain a second EventState model, or run periodic REST polling.

## Operational invariants

- EventState/TeamState are projections, not the durable source of truth.
- Provider endpoint records remain authoritative even if every projection cache is evicted.
- Snapshot, discovery, analytics-input, and analytics-publication GETs are read-only.
- No queue consumer, Redis cache, Vercel realtime bridge, or browser provider client participates in the data path.
