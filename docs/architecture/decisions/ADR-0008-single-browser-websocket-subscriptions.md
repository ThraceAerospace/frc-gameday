# ADR-0008: One browser WebSocket with a shared multiplexer

- **Status:** Accepted for one-connection topology; payload and reconnect rules superseded by ADR-0020
- **Date:** 2026-11-17
- **Scope:** Public live event transport and frontend migration

## Context

FieldView's SharedWorker maintains one WebSocket connection per browser origin and distributes updates to multiple tabs and UI surfaces. The Gameday page supports up to nine tiles, each subscribing to a distinct event key. Other pages may also consume live event or analytics updates. Opening more tiles or pages must not create a corresponding number of browser WebSocket connections.

Connecting directly to one EventRuntime stream for every subscribed event would violate this one-connection invariant. Creating one multiplexer per browser connection would also be unnecessary: a single multiplexer can serve multiple clients and deduplicate their subscriptions.

This is a small application and does not currently need a sharded connection service. Start with one shared Multiplexer Durable Object. Add more multiplexers only if measured demand or platform limits demonstrate that the single instance is insufficient.

## Decision

Each SharedWorker maintains **one browser WebSocket connection to one shared Multiplexer Durable Object**. That multiplexer serves multiple independent browser client connections and tracks each client's logical subscriptions.

The SharedWorker is the browser-side connection owner. Pages and UI surfaces using that SharedWorker acquire and release logical subscriptions through it; they do not open their own event WebSockets. The Gameday page may hold up to nine distinct event-key subscriptions, and other live-data pages use the same channel. Multiple pages or clients requesting the same topic share one upstream registration at the multiplexer.

### Connection and subscription flow

1. The public Worker routes each incoming browser WebSocket to the single shared Multiplexer Durable Object.
2. The SharedWorker sends validated logical subscribe/unsubscribe messages. A subscription identifies its topic and resource key, such as event state for an event key or analytics for an event key. Keepalive is also supported.
3. The multiplexer maintains a per-client subscription set and a reverse index from topic/resource key to the connected clients that need it.
4. The multiplexer registers its own identifier with the authoritative runtime for a topic only while at least one connected client subscribes to it. Multiple clients subscribing to the same topic cause only one active runtime-to-multiplexer registration. Each change to the connected-client set sends the desired registration state with a monotonically increasing generation; EventRuntime ignores delayed requests with an older generation, preventing subscribe/unsubscribe races from leaving stale upstream state.
5. EventRuntime (or the authoritative analytics publisher) records the multiplexer identifier for each topic it owns. When that topic's revision changes, it sends one small revision/invalidation notification to the multiplexer.
6. The multiplexer forwards a notification only to browser connections subscribed to the matching topic/resource key. Clients that did not subscribe must not receive the notification.
7. The client fetches the canonical HTTP snapshot before opening `/stream`, then applies data-bearing WebSocket updates using resource revisions. WebSocket acknowledgements, notifications, and reconnects never trigger HTTP refetches. See ADR-0020.
8. When the last client unsubscribes from a topic, the multiplexer unregisters itself from that topic's authoritative runtime. On socket close, all of that client's subscriptions are removed; upstream registrations are removed when no remaining client needs them.
9. Reconnect creates a new browser WebSocket to the shared multiplexer. The SharedWorker resends its active subscriptions and retains its last good in-memory snapshot; it does not issue HTTP recovery reads from WebSocket events or reconnects. Event-state and analytics subscriptions are both active topics.

### Topic ownership and filtering

- Event state notifications originate from the EventRuntime that owns that event's authoritative state and revision.
- Analytics notifications originate from the authoritative analytics result owner/publisher. Analytics and event-state subscriptions and revisions are independent; an analytics update does not imply an event-state update.
- Runtime-to-multiplexer delivery is filtered by registered topic/resource key: the multiplexer receives notifications only for topics with at least one interested client.
- Multiplexer-to-client delivery is filtered by its per-client subscription index: only interested clients receive the notification.
- Client-side filtering may remain defensive, but it is not the primary filtering mechanism. Unsubscribed clients must not receive unrelated live messages.
- Publication bodies are transient transport payloads only; the Multiplexer never stores canonical state. Data-bearing publication and cache semantics are defined by ADR-0013.

The multiplexer owns browser connection lifecycle and logical subscription routing only. It may forward committed DTO payloads but never stores them as canonical state. EventRuntime and the analytics result owner remain authoritative for their respective data and revisions.

## Public and internal access

- The browser-facing multiplexed WebSocket is public and read-only; it requires no user login or browser-held service credential.
- Browser messages are restricted to validated subscribe, unsubscribe, and keepalive operations. They cannot mutate event or analytics state.
- Runtime registration and notification delivery are internal service-to-service operations protected by service credentials or an equivalently restricted internal binding.
- Public canonical snapshots and analytics results remain available through their respective read-only endpoints.
- Event keys and topic names are validated before addressing a Durable Object or runtime resource.

## Consequences

- One SharedWorker browser WebSocket serves all live subscriptions for that worker, including up to nine Gameday event tiles and live subscriptions from other pages.
- One Multiplexer Durable Object serves multiple browser clients. Its upstream registration is deduplicated by topic, and its downstream fan-out is filtered per client.
- Runtime notification fan-out is one delivery per changed topic/revision to the shared multiplexer, rather than one delivery per interested browser connection.
- EventRuntime and analytics owners remain the source of truth. Data-bearing notifications avoid hidden HTTP reads after the initial canonical snapshot and keep realtime delivery on one transport.
- Abrupt disconnect cleanup, stale registration pruning, multi-client fan-out, subscription deduplication, and reconnect recovery must be tested.
- The single multiplexer is the initial design, not an assumption that one instance will scale indefinitely. Measure connection count, message volume, CPU/duration, and delivery latency. Introduce sharding or partitioning only when observed demand or platform limits justify it, while preserving the browser protocol.
- The event-scoped public stream is retired. The shared Multiplexer `/stream` is the only browser WebSocket path; EventRuntime publishes data-bearing snapshots and team-event patches to it.
- Frontend consumption and production deployment remain separate migration steps. No production cutover or deployment is authorized by this ADR.
