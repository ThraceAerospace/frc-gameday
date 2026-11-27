# ADR-0012: Scope-based TBA webhook routing

- **Status:** Accepted, clarified for the current Worker runtime
- **Date:** 2026-11-21
- **Scope:** Cloudflare Worker webhook ingress, EventRuntime, TeamRuntime

## Context

TBA webhook payloads contain scope information for many message types. The Worker's webhook ingress is the routing boundary: it authenticates and validates the provider envelope, identifies the event and any explicitly named teams, and dispatches the unchanged payload to the owners of the affected data.

## Decision

### 1. Ingress is the routing boundary

The Worker webhook route:
1. Enforces the payload-size limit.
2. Verifies `X-TBA-HMAC` against the exact raw request body.
3. Parses and validates the envelope.
4. Resolves the event key and affected team keys from the documented message-type payload shape.
5. Deduplicates target keys within the routing plan.
6. Dispatches the original unchanged payload to every affected runtime.

Ingress does not normalize provider payloads or own canonical state. It uses an explicit, tested message-type routing table. Unknown message types are acknowledged only when safely classifiable as non-mutating; otherwise they return a client error.

### 2. Runtime ownership remains disjoint

- EventRuntime receives event-scoped notifications and applies only event-owned state changes.
- Each affected TeamRuntime receives the notification directly and applies only its own team-scoped state.
- No runtime forwards the webhook to another runtime as part of ordinary webhook handling.
- EventRuntime does not dispatch TeamRuntime webhook delivery.
- TeamRuntime does not persist a second authoritative copy of canonical event provider resources.
- Analytics orchestration remains a separate Workflow operation using versioned comparison inputs; ordinary webhook delivery does not synchronously recalculate every team's state.

### 3. Routing matrix

| Message type | EventRuntime | TeamRuntime targets |
| --- | --- | --- |
| `match_score` | Event match collection and event analytics invalidation | Unique teams in `match.alliances.red.teams` and `match.alliances.blue.teams`; optional `team_key` |
| `match_video` | Event match collection | Optional `team_key` and identities explicitly present in the match payload; do not infer absent participants |
| `upcoming_match` | Event schedule state | Unique `team_keys`; optional `team_key` |
| `starting_comp_level` | Event competition-level state | None unless a team-specific projection explicitly consumes it |
| `alliance_selection` | Event metadata and alliance/status resources | Optional team-targeted `team_key`; do not infer a selected-team list |
| `awards_posted` | Event awards collection | Teams identified by each award's `recipient_list[].team_number`; optional `team_key` |
| `schedule_updated` | Event schedule/match collection | Event roster only when supplied by an already-available routing index; no hidden provider fetch |
| `ping`, `broadcast`, `verification` | No runtime state mutation | None |

An absent team target list means no TeamRuntime dispatch. Do not guess recipients or fetch provider data from ingress to discover them.

### 4. Delivery, idempotency, and failures

- Derive one stable webhook ID from SHA-256 of the exact raw body and pass it to each target.
- Each runtime deduplicates independently.
- Dispatch targets concurrently. One target failure must not prevent attempts to other targets.
- Return success only when every required target accepts the notification. Partial delivery is observable and retryable; retries are safe because each target deduplicates.
- Runtime registration is separate from webhook delivery. Ingress must not register targets as a side effect.
- Duplicate or semantically unchanged notifications must not cause redundant state writes.
- Keep the route within TBA's response timeout. Any future durable delivery mechanism requires a separately justified design; there is no Queue compatibility path.

### 5. Provider data and freshness

Pass the original TBA `message_data` unchanged to runtimes. Do not manufacture ETags, HTTP fetch timestamps, or provider revisions from webhook receipt time. A webhook may update locally reconciled data while retaining the provider HTTP representation and validator. A later conditional provider request remains responsible for refreshing that representation.

## Consequences

Webhook routing is explicit and scope-aware. EventRuntime and TeamRuntime remain independent owners, partial delivery can be retried idempotently, and webhook handling does not become a provider proxy or global scheduler.

## Implementation boundary

The Worker ingress verifies raw-body HMAC and derives a stable webhook identity. It dispatches to EventRuntime and deduplicated TeamRuntime targets according to the routing table. Any new message type or routing behavior must update the table and its contract tests.

See [the runtime lifecycle](../../development/FIELDVIEW-RUNTIME.md) and [ADR-0020](ADR-0020-ephemeral-state-projections-and-snapshot-first-stream.md).
