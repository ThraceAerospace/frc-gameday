# ADR-0008: One browser WebSocket with a shared Multiplexer

- **Status:** Accepted for the one-connection topology; payload and recovery rules superseded by ADR-0020
- **Date:** 2026-11-17
- **Scope:** Public live event transport and frontend synchronization

## Decision retained

Each browser SharedWorker maintains one WebSocket connection to the shared Multiplexer Durable Object. The Multiplexer serves multiple browser clients and deduplicates logical subscriptions by topic and resource identity.

Pages and UI surfaces acquire/release logical subscriptions through the SharedWorker; they do not open their own event WebSockets. The Multiplexer tracks subscriptions per client and forwards only matching topics to interested clients. It owns connection and subscription coordination, not canonical data.

EventRuntime owns event-state changes. The appropriate analytics owner publishes analytics changes. The public browser channel is read-only and accepts only validated subscription/keepalive operations. Internal runtime-to-Multiplexer registration and publication delivery are protected service operations.

## Current connection lifecycle

1. The browser obtains the canonical HTTP snapshot.
2. The SharedWorker opens or reuses the single public `/stream` connection.
3. It registers its active logical subscriptions with Multiplexer.
4. Runtime owners publish data-bearing updates for subscribed topics.
5. Multiplexer forwards each update only to clients subscribed to the matching topic/resource.
6. The SharedWorker applies valid, ordered messages to its in-memory cache and distributes changes to its clients.
7. On reconnect, the SharedWorker restores subscriptions only; it does not refetch snapshots or analytics.

## Payload and recovery contract

ADR-0020 is authoritative:
- Event state messages carry the changed EventState snapshot data.
- Team-event messages carry the changed patch/data and its owning scope.
- Analytics messages carry the committed analytics publication.
- Messages include identity and ordering/revision metadata.
- Revision-only invalidations are invalid.
- Notifications, acknowledgements, gaps, disconnects, and reconnects never trigger HTTP refetches.
- The SharedWorker cache is memory-only; normalized snapshots are not persisted in IndexedDB.

The Multiplexer forwards transient publication payloads and does not persist canonical snapshots or an unbounded replay log. The one-Multiplexer topology remains the initial design; sharding requires measured evidence of platform or capacity limits.

See [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md) for the complete normative realtime and projection contract.
