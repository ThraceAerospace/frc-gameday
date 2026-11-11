# EventState and EventAnalytics lifecycle

This document records the current data lifecycle and the target contract boundary for FieldView. The goal is to let acquisition, persistence, and delivery infrastructure evolve independently of the models consumed by clients.

## Core distinction

- **EventState** is the active, event-scoped state of the competition: event metadata, teams, matches, statuses, alliances, OPRs, and the current/last-match Statbotics records needed by live Views.
- **EventAnalytics** is the event-scoped analytical model: normalized analytics output, source coverage/freshness, and FieldView-derived findings.

They are companion models, not one combined state. EventState changes frequently during an event. EventAnalytics can depend on EventState inputs, historical context, and separate provider collections, and therefore has its own acquisition and refresh lifecycle.

Neither client model is the durable database. Redis is current server-side persistence/cache infrastructure; the client-side EventState is an active runtime object.

## Current EventState lifecycle

### 1. Demand and ownership

1. A live route registers a shared live-runtime lease.
2. A View calls `useEventState(eventKey)`.
3. `sharedWorkerClient` opens or reuses the named origin-wide SharedWorker.
4. The first subscriber for an event sends a `subscribe` message.
5. `eventState.shared-worker.ts` creates one `EventState` instance for that event key, or reuses the existing instance.
6. The worker subscribes the MessagePort to that instance and immediately sends its current snapshot.

The SharedWorker owns the event map and the physical event-data WebSocket. Additional tabs and Views share the same EventState instance and do not create independent acquisition loops.

### 2. Initial acquisition

When the first EventState subscriber arrives, `EventState.start()`:

- subscribes to event-scoped WebSocket invalidations and connection status;
- fetches event metadata;
- fetches the event team roster;
- fetches the canonical full match schedule and derives next/last match using the shared match helpers;
- fetches team statuses;
- fetches playoff alliances;
- fetches OPR/DPR/CCWM data;
- acquires Statbotics match predictions for the current next match and most recently completed match.

Each resource has request-generation protection so an older response cannot overwrite a newer request. A failed resource refresh preserves the previous usable snapshot where possible.

### 3. Server acquisition and cache

The browser requests FieldView API routes, not TBA directly. The application-facing TBA and Statbotics services own provider access.

For TBA:

- Redis is the application cache.
- TBA ETag and `Cache-Control: max-age` determine freshness; FieldView does not hardcode TBA max-age.
- The full event match schedule is the canonical match cache.
- A 304 renews Redis expiry using TBA's supplied cache lifetime.
- Authenticated TBA webhooks mutate the relevant existing Redis cache before broadcasting invalidation.
- Webhook cache mutation does not create another cache layer.

For Statbotics, the application-facing service owns requests and cache behavior. It honors upstream cache guidance and the documented fallback windows, preserves stale values on refresh failure, and backs off failed refreshes.

### 4. Realtime invalidation and reconciliation

The event-data WebSocket carries invalidation messages, not authoritative match payloads.

- Upcoming-match notifications refresh the match schedule.
- Match-score notifications refresh matches, statuses, playoff alliances, and OPRs.
- Match-video notifications refresh matches.
- Alliance-selection notifications refresh playoff alliances.
- Other and unknown message types trigger a broader reconciliation.

Fallback polling runs on the existing five-minute cadence for matches, statuses, alliances, and OPRs. A webhook causes an immediate API re-read followed by a one-shot re-read after 65 seconds. The 65-second timer does not modify the Redis cache entry's `expiresAt` or force an upstream TBA request; whether a read revalidates with TBA depends on the existing TBA cache freshness. These timers are event-scoped.

The worker's heartbeat detects abandoned tabs. A disconnected worker can be reconstructed; tabs reconnect and re-register their subscriptions, and EventState is rebuilt from the server APIs and Redis-backed caches.

### 5. Snapshot distribution and teardown

Every EventState update notifies its listeners. The SharedWorker forwards snapshots to subscribed MessagePorts. The tab adapter stores the latest snapshot and notifies local React subscribers.

Remote displays are read-only consumers of controller-published EventState snapshots; they do not independently acquire event data.

When an event has no remaining subscribers, EventState stops its timers and WebSocket subscriptions. When the final live client/lease disappears, the SharedWorker releases the physical WebSocket and stops its watchdog. Worker memory is disposable; Redis/server caches are the recovery source.

## Current EventAnalytics lifecycle

The analytics acquisition path is server-side, but it is currently a separate HTTP lifecycle from the SharedWorker-owned EventState lifecycle.

1. `GET /api/insights/event/<eventKey>` validates the event key and requests the current analytics snapshot.
2. `getEventAnalyticsSnapshot` reads the event's Redis job at `insights:progressive:<eventKey>`. If no job exists, it acquires the event, team roster, canonical full match schedule, OPRs, rankings, and playoff alliances from TBA. Rankings and playoff alliances are optional in this initialization path and failures are converted to `null`.
3. The route initializes/reads the season-cohort job, then awaits `advanceEventAnalytics` and `advanceSeasonCohort` together.
4. `advanceEventAnalytics` uses an event-scoped Redis lock, obtains event-filtered Statbotics qualification and elimination match collections, pairs them with the canonical TBA schedule, acquires FRC Colors event data, and runs the FieldView calculation functions.
5. The event job is persisted in Redis with a one-year TTL. Normal opens reuse the persisted snapshot; an explicit `?refresh=1` request refreshes the TBA schedule/OPR/rankings/alliances and Statbotics/FRC Colors collection.
6. The season cohort is a separate Redis job with a 24-hour TTL, a 20-second work budget, bounded batches, and bounded concurrency. The route attaches its snapshot and the season-aware team insights before returning.

**Execution behavior:** the current route declares `maxDuration = 60` and awaits both advancement functions before responding. It does not currently use Vercel `waitUntil` for this work. The dashboard fetches the event analytics endpoint on mount and on explicit user refresh; it does not currently poll for collection progress.

**Delivery behavior:** `EventAnalyticsSurface` calls `useEventState` to expose the event WebSocket connection status to the dashboard. The analytics payload itself is fetched independently by `EventAnalyticsDashboard` over HTTP. EventAnalytics is not yet a SharedWorker-owned subscription and is not yet delivered through the same snapshot channel as EventState.

**Contract boundary:** the v1 envelope adds schema version, event identity, generation time, provenance, and source metadata while retaining the existing `EventAnalyticsResponse` payload. That compatibility payload still contains provider-shaped TBA and Statbotics records; it is not yet a provider-independent FieldView DTO.

**Known metadata limitation:** the current grouped TBA source status can report `ready` when optional rankings or playoff-alliance acquisition failed and those values are `null`. Source status should eventually be tracked per resource or expose a partial state with missing-resource details.

## EventAnalytics v1 contract

The first version is an additive envelope around the current analytics response:

- `schemaVersion` identifies the client contract version.
- `eventKey` identifies the event represented by the model.
- `generatedAt` records when this particular response model was assembled.
- `provenance` identifies the upstream or FieldView origin of each major data group.
- `sources` reports source status and the latest successful acquisition timestamp independently for TBA, Statbotics, and FRC Colors.
- Existing analytics fields and calculations remain unchanged for compatibility.

Source status semantics:

| Status | Meaning |
| --- | --- |
| `pending` | Acquisition has not completed or has not yet been attempted. |
| `ready` | The source collection completed with usable data. |
| `partial` | Some expected records are available, but coverage is incomplete. |
| `unavailable` | Acquisition failed or no usable records were returned. |

Timestamps are Unix milliseconds. A model's `generatedAt` is not a claim that every source was refreshed at that moment; consumers must use `sources.*.updatedAt` to reason about source freshness.

### Compatibility boundary

The v1 envelope deliberately preserves the existing typed TBA and Statbotics records inside the analytics response so the current dashboard does not change behavior. That is a compatibility bridge, not the final provider-independent DTO design.

As the contract evolves, FieldView-owned DTOs should become the stable client-facing representation. Provider-specific response objects should be mapped at the acquisition/normalization boundary, with raw provider payloads retained only where they are genuinely useful for traceability or detailed evidence. Contract changes must be versioned rather than silently changing the meaning or shape of existing fields.

## Target lifecycle

The intended steady state is:

```text
TBA / Statbotics / FRC Colors / future providers
                    |
          acquisition + adapters
                    |
       cache / persistence / reconciliation
                    |
          +---------+----------+
          |                    |
       EventState          EventAnalytics
          |                    |
          +---------+----------+
                    |
           SharedWorker delivery
                    |
        tab / remote snapshot adapters
                    |
          reusable FieldView Views
```

The SharedWorker should request each model by event key, share one in-flight request/subscription among consumers, retain the latest snapshot for active subscribers, and distribute updates through MessagePorts. A remote display receives the same models through its controller-published snapshot channel rather than opening a second acquisition path.

EventState and EventAnalytics retain separate freshness and refresh policies. An EventState match update must not automatically trigger a full historical analytics rebuild. The analytics service should eventually support targeted/incremental updates for changed inputs, while preserving the current explicit-refresh semantics until that behavior is separately designed and tested.

The future Cloudflare implementation should satisfy the same contract. It may replace Vercel functions and Redis-backed acquisition/persistence, but it must return the same versioned FieldView models. The SharedWorker and Views should not care which infrastructure produced them.

## Implementation sequence

1. Establish and version the EventAnalytics contract and source metadata. **Initial v1 envelope is now implemented.**
2. Add contract validation and fixture-based tests for complete, partial, pending, and unavailable source states.
3. Add a SharedWorker-owned EventAnalytics lifecycle beside EventState, with shared subscriptions, request deduplication, refresh commands, and read-only remote snapshot delivery.
4. Migrate the analytics dashboard to consume the shared model without changing its calculations or visual behavior.
5. Reuse the same analytics data/components on team, match, event, and remote surfaces.
6. Only then evaluate moving acquisition/persistence to Cloudflare behind the same contracts.
