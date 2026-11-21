# ADR-0012: Scope-based TBA webhook routing

- **Status:** Accepted
- **Date:** 2026-11-21
- **Scope:** Cloudflare Worker webhook ingress, EventRuntime, TeamRuntime

## Context

The current ingress validates a TBA webhook, registers the EventRuntime with TaskScheduler, and forwards the payload only to EventRuntime. EventRuntime persists/deduplicates the notification, applies event-scoped changes, and later coordinates team-scoped recalculation. Live-event logs show this creates a multi-hop path for one source notification.

TBA webhook payloads contain enough scope information for many message types to identify affected resources at ingress. The payload's `message_type` determines which fields are authoritative for routing. TBA documents `upcoming_match`, `match_score`, `match_video`, `starting_comp_level`, `alliance_selection`, `awards_posted`, `schedule_updated`, `ping`, `broadcast`, and `verification`. Some notification fields are optional and some payloads are event-wide rather than team-specific.

## Decision

### 1. Ingress is the routing boundary

The Worker webhook route is responsible for:
1. Enforcing the payload-size limit.
2. Verifying `X-TBA-HMAC` against the exact raw request body.
3. Parsing and validating the envelope.
4. Resolving the event key and affected team keys from the message type's documented payload shape.
5. Deduplicating target keys within the routing plan.
6. Dispatching the original unchanged payload directly to every affected runtime.

The route does not normalize provider payloads or own canonical state. It uses an explicit, exhaustively tested message-type routing table. Unknown message types are acknowledged only when they can be safely classified as non-mutating; otherwise they return a client error so unsupported routing is visible.

### 2. Runtime ownership remains disjoint

- EventRuntime receives event-scoped notifications and applies only event-owned state changes.
- Each affected TeamRuntime receives the same notification directly and applies only its own team-scoped projection/state.
- No runtime forwards the webhook to another runtime as part of ordinary webhook handling.
- EventRuntime must not be the dispatcher for TeamRuntime webhook delivery.
- TeamRuntime must not persist a second authoritative copy of the event's canonical provider resource. For example, EventRuntime owns the canonical event match collection; a TeamRuntime may update only its own `FieldViewTeamEventState` projection for matches involving that team.
- TeamRuntime analytics continues to use the shared versioned comparison input, but ordinary webhook delivery must not require EventRuntime to fan out a second notification or recalculate every team's state serially.

### 3. Routing matrix

| Message type | EventRuntime | TeamRuntime targets |
| --- | --- | --- |
| `match_score` | Event match collection and event analytics invalidation | Unique teams in `match.alliances.red.teams` and `match.alliances.blue.teams` |
| `match_video` | Event match collection | Unique teams in both match alliances |
| `upcoming_match` | Event upcoming-match/schedule state | Unique `team_keys`; if absent, optional `team_key` only |
| `starting_comp_level` | Event competition-level state | None unless a team-specific projection explicitly consumes it |
| `alliance_selection` | Event metadata and alliance/status resources | Teams explicitly present in the event's alliance-selection data, if supplied; do not infer a roster from the event metadata object |
| `awards_posted` | Event awards collection | Teams identified by award `recipient_list[].team_number`; a team-targeted webhook's optional `team_key` takes precedence when present |
| `schedule_updated` | Event schedule/match collection | Event roster only when supplied by an already-available routing index; do not perform a hidden provider fetch or ask EventRuntime to proxy the dispatch |
| `ping`, `broadcast`, `verification` | No runtime state mutation | None |

An absent team target list means no TeamRuntime dispatch. Do not guess or synthesize recipients. A future event-to-team routing index may support event-wide notifications, but its ownership, consistency, and update lifecycle must be separately specified.

### 4. Delivery, idempotency, and failure behavior

- Derive one stable webhook ID from SHA-256 of the exact raw body and pass it to every target.
- Each runtime deduplicates independently. A successful delivery to one target does not suppress delivery to another.
- Dispatch targets concurrently. One target's failure must not prevent attempts to other targets.
- Return success only when every required target has accepted the notification. Partial delivery must be observable and retryable; a retry is safe because each target deduplicates.
- Do not register each webhook target with TaskScheduler as a side effect of ingress. Runtime lifecycle/discovery is separate from webhook delivery.
- A target persists only a real change to its authoritative state. Duplicate or semantically unchanged notifications must not cause redundant state writes.
- The webhook route must remain within TBA's 10-second response timeout. If direct bounded dispatch cannot reliably complete within that deadline, introduce an explicitly durable delivery mechanism rather than silently acknowledging dropped work.

### 5. Source data and freshness

Pass the original TBA `message_data` unchanged to runtimes. Do not manufacture ETags, HTTP fetch timestamps, or provider revisions from webhook receipt time. A webhook may update locally reconciled data while retaining the provider HTTP representation and validator unchanged. A later conditional fetch remains responsible for refreshing the provider representation.

### 6. Explicit non-goals

- No WebSocket mesh between Durable Objects.
- No EventRuntime-to-TeamRuntime webhook relay.
- No global provider request lock or serialized queue.
- No duplicate canonical event match storage in TeamRuntime.
- No provider fetch from ingress merely to discover team recipients.
- No blanket event-roster fan-out when the payload does not identify recipients.

## Consequences

- A match webhook has one ingress routing decision and direct delivery to EventRuntime plus only the participating TeamRuntimes.
- EventRuntime no longer acts as the webhook coordinator for team-scoped state.
- TeamRuntime can update its team-specific event projection independently.
- Event-wide messages without team identities remain event-scoped until a separately maintained roster index exists.
- Delivery must be idempotent and partial failures must be visible; a plain `Promise.all` that rejects early is insufficient.
- Tests must cover every documented TBA message type, optional fields, malformed identities, duplicate team keys, partial target failure, duplicate delivery, and unchanged-state write suppression.

## References

- The Blue Alliance webhook documentation: https://www.thebluealliance.com/apidocs/webhooks
