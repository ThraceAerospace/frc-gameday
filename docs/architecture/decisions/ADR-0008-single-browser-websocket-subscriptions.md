# ADR-0008: One browser WebSocket with shared multiplexed subscriptions

- **Status:** Accepted
- **Date:** 2026-11-17
- **Scope:** Public live event transport and frontend migration

## Context

FieldView's existing browser architecture uses a SharedWorker to maintain one WebSocket connection per browser origin and distribute updates to multiple tabs and UI surfaces. The Gameday page supports up to nine tiles, with each tile subscribing to a distinct event key. Other pages may also consume live event or analytics updates. Opening more tiles or pages must not create a corresponding number of browser WebSocket connections.

Connecting directly to one EventRuntime stream for every subscribed event would violate the one-connection invariant and multiply browser connections as users open more events. A single globally shared multiplexer Durable Object would instead serialize all users' socket and subscription traffic through one global hot spot. Creating one multiplexer Durable Object per browser connection would avoid that global hot spot, but would unnecessarily prevent multiplexers from serving multiple clients and increase the number of Durable Objects.

The desired architecture therefore shares each multiplexer across multiple browser connections, while distributing connections across multiple multiplexer instances.

## Decision

Each SharedWorker maintains **one browser WebSocket connection** to one instance in a **sharded pool of shared multiplexer Durable Objects**. A multiplexer serves multiple independent client WebSockets and tracks each client's logical subscriptions.

The SharedWorker is the browser-side connection owner. Pages and UI surfaces using that SharedWorker acquire and release logical subscriptions through it; they do not open their own event WebSockets. The Gameday page may hold up to nine distinct event-key subscriptions, and other live-data pages use the same channel. Multiple pages requesting the same topic within one SharedWorker share one logical upstream subscription.

### Connection and subscription flow

1. The public Worker routes a new browser WebSocket to one multiplexer shard. The shard assignment strategy and pool sizing are implementation/configuration concerns; the design must support multiple shards and must not depend on a single global Durable Object.
2. The SharedWorker sends validated logical subscribe/unsubscribe messages. A subscription identifies its topic and resource key, such as event state for an event key or analytics for an event key. Keepalive is also supported.
3. The multiplexer maintains a per-client subscription set and a reverse index from topic/resource key to the connected clients that need it.
4. A multiplexer registers its own opaque identifier with the authoritative runtime for a topic only while at least one connected client on that shard subscribes to it. Multiple clients on the same shard subscribing to the same topic cause only one runtime-to-shard registration.
5. EventRuntime (or the authoritative analytics publisher) records the subscribed multiplexer shard identifiers for each topic it owns. When that topic's revision changes, it sends one small revision/invalidation notification to each registered shard.
6. The multiplexer forwards a notification only to the browser connections on that shard that are subscribed to the matching topic/resource key. Clients that did not subscribe must not receive the notification.
7. The client fetches the canonical snapshot or analytics result through its read-only public endpoint and applies it only if the received revision is not older than its current version. WebSocket messages carry invalidation/revision metadata, not full domain snapshots or analytics result payloads.
8. When the last client on a shard unsubscribes from a topic, the shard unregisters itself from that topic's authoritative runtime. On socket close, all of that client's subscriptions are removed; registrations are removed when no remaining client on the shard needs them. Failed delivery to a definitively missing shard permits stale-registration pruning.
9. Reconnect creates a new browser WebSocket to a multiplexer shard. The SharedWorker resends its active subscriptions and performs revision/snapshot recovery; no event payload replay is required.

### Topic ownership and filtering

- Event state notifications originate from the EventRuntime that owns that event's authoritative state and revision.
- Analytics notifications originate from the authoritative analytics result owner/publisher. Analytics and event-state subscriptions and revisions are independent; an analytics update does not imply an event-state update.
- Runtime-to-multiplexer delivery is filtered by registered topic/resource key: only shards with at least one interested client are notified.
- Multiplexer-to-client delivery is filtered again by the shard's per-client subscription index: only interested clients receive the notification.
- Client-side filtering may remain defensive, but it is not the primary filtering mechanism. Unsubscribed clients must not receive unrelated live messages.
- A topic notification contains only enough information to identify the topic/resource and its new revision (plus protocol metadata). It does not contain a copied snapshot or analytics result.

The multiplexer owns browser connection lifecycle and logical subscription routing only. EventRuntime and the analytics result owner remain authoritative for their respective data and revisions. Snapshot and analytics data are never copied into the multiplexer as canonical state.

## Public and internal access

- The browser-facing multiplexed WebSocket is public and read-only; it requires no user login or browser-held service credential.
- Browser messages are restricted to validated subscribe, unsubscribe, and keepalive operations. They cannot mutate event or analytics state.
- Runtime registration and shard notification delivery are internal service-to-service operations protected by service credentials or an equivalently restricted internal binding.
- Public canonical snapshots and analytics results remain available through their respective read-only endpoints.
- Event keys and topic names are validated before creating or addressing a Durable Object or runtime resource.

## Consequences

- One SharedWorker browser WebSocket serves all live subscriptions for that worker, including up to nine Gameday event tiles and live subscriptions from other pages.
- Each multiplexer shard serves multiple browser clients. A shard receives at most one notification per changed topic/revision, regardless of how many of its connected clients subscribe to that topic.
- Runtime fan-out scales with the number of shards that have at least one interested client, rather than the number of interested browser connections.
- Multiplexer fan-out is restricted to clients subscribed to the changed topic. Uninterested clients receive no message.
- Multiple shards avoid a single global Durable Object hot spot. Pool sizing, assignment, rebalancing, per-shard limits, and overload behavior must be designed and measured during implementation; no fixed shard count is implied by this ADR.
- EventRuntime and analytics owners remain the source of truth. Revision-only notification plus canonical reads limits WebSocket bandwidth and makes reconnect recovery straightforward.
- Abrupt disconnect cleanup, stale registration pruning, multi-client shard fan-out, subscription deduplication, and reconnect recovery must be tested.
- The event-scoped public stream is superseded as the browser integration path by the shared multiplexed stream. EventRuntime's publication API remains revision-only.
- Frontend consumption and production deployment remain separate migration steps. No production cutover or deployment is authorized by this ADR.
