# ADR-0008: One browser WebSocket with multiplexed event subscriptions

- **Status:** Accepted
- **Date:** 2026-11-17
- **Scope:** Public live event transport and frontend migration

## Context

FieldView's existing browser architecture uses a SharedWorker to maintain one WebSocket connection per browser origin and distribute updates to multiple tabs and UI surfaces. The public event stream introduced by ADR-0007 is event-scoped. Connecting directly to one EventRuntime stream for every subscribed event would violate the existing one-connection invariant and multiply browser WebSocket connections as the user opens more events.

Multiple WebSockets would likely have a modest cost at ordinary usage levels, but they are unnecessary for the desired client contract and would weaken an intentional piece of the existing architecture.

A single globally shared SubscriptionHub Durable Object is also undesirable: every user's socket and subscription traffic would serialize through one Durable Object, creating an avoidable global hot spot.

## Decision

The browser maintains **one WebSocket per SharedWorker connection**, and multiplexes all event subscriptions over that one channel.

Use a **per-client-connection SubscriptionHub Durable Object**, not one global hub:

1. The Worker creates a uniquely named SubscriptionHub for each incoming browser WebSocket connection.
2. The SharedWorker sends logical `subscribe` and `unsubscribe` messages containing event keys over that one socket.
3. The SubscriptionHub registers its opaque connection identifier with each corresponding EventRuntime using an authenticated internal operation.
4. Each EventRuntime durably records the subscribed hub identifiers for its own event.
5. When an event snapshot revision changes, EventRuntime sends a small `{ type: "snapshot.changed", event_key, version }` notification to each registered SubscriptionHub.
6. The SubscriptionHub forwards notifications to its connected browser socket. The client fetches the canonical snapshot from the existing public snapshot endpoint and applies it only when its version is not older than its current state.
7. On unsubscribe or socket close, the SubscriptionHub unregisters itself from the affected EventRuntime instances. Failed delivery to a definitively missing hub allows EventRuntime to prune stale registrations.
8. Reconnect creates a new hub connection. The SharedWorker resends its active logical subscriptions and performs snapshot/version recovery; no event payload replay is required.

The hub owns connection lifecycle and logical subscription routing only. EventRuntime remains the sole owner of event state, snapshot revisions, and event-specific publication. Snapshot data is never copied into the hub.

## Public and internal access

- The browser-facing multiplexed WebSocket is public and read-only; it requires no user login or browser-held service credential.
- Browser messages are restricted to validated subscribe, unsubscribe, and keepalive operations. They cannot mutate event state.
- EventRuntime registration and hub notification endpoints are internal service-to-service operations protected by `RUNTIME_ADMIN_TOKEN`.
- Public canonical snapshots remain available through `GET /events/:eventKey/snapshot`.
- Event keys are validated before creating or addressing a Durable Object.

## Consequences

- The SharedWorker retains one browser WebSocket regardless of the number of subscribed events.
- Separate browser sessions receive separate SubscriptionHub instances; there is no single global WebSocket hub bottleneck.
- EventRuntime fan-out work grows with the number of active clients subscribed to that event, which is the necessary delivery cost for notifying those clients.
- SubscriptionHub instances are short-lived connection coordinators and do not become canonical data stores.
- Abrupt disconnect cleanup and stale registration pruning must be tested; reconnect must always recover through subscription resubmission plus canonical snapshot reads.
- The public event-scoped stream is superseded as the browser integration path by the multiplexed stream. EventRuntime's publication API remains revision-only.
- Frontend consumption and production deployment remain separate migration steps. No production cutover or deployment is authorized by this ADR.