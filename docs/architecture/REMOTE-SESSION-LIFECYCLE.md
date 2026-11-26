# Remote-session lifecycle and storage budget

**Status:** Implemented in code on `fieldview-architecture-migration`; end-to-end Preview validation remains pending.

## Decision

The remote-session Durable Object does not use alarms, durable leases, heartbeat messages, or periodic storage writes. It has at most two participants (controller and display), so accepted hibernatable WebSockets are the presence registry.

- The Durable Object checks its accepted WebSocket set to enforce one active socket per role.
- Role and per-connection token are stored as WebSocket attachments, which survive WebSocket hibernation.
- Signaling is validated and forwarded directly to the opposite role.
- Normal and abnormal socket closure remove the socket from the accepted socket set; a later connection can claim that role.
- There is no session-state persistence, alarm scheduling, alarm cleanup, or browser heartbeat traffic.
- The DO can hibernate while connections remain open; incoming WebSocket events reactivate it.

## Resource rationale

Cloudflare D1 `row_written` usage is a scarce budget for FieldView. This object has no need for D1 writes at all. Durable Object storage writes and alarm invocations are separate platform meters, but the same conservation principle applies: do not add scheduled work or persistent writes without a demonstrated requirement.

The remote-session runtime therefore must not call `storage.put`, `storage.delete`, `storage.setAlarm`, or `storage.deleteAlarm`. Tests make those methods fail if called. Application-level heartbeats are also removed because they existed only to renew durable leases.

## Tradeoff

An abandoned pairing code has no persistent record to clean up. Once both sockets close, the object has no session state to retain. A live but network-partitioned WebSocket remains present until the platform closes it; reconnection behavior is handled by the client and WebSocket lifecycle, not a periodic lease. If future evidence shows stale live connections cause a real correctness issue, evaluate an explicit protocol-level solution before introducing alarms or persistence.

## Validation boundary

This change is source-only. It does not deploy a Worker, provision a Durable Object namespace, modify Cloudflare resources, or change billing settings. Preview pairing, reconnection, simultaneous-role exclusivity, and hibernation behavior still require end-to-end validation.
