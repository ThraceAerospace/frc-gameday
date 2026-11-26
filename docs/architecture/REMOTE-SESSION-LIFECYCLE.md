# Remote-session lifecycle and storage budget

**Status:** Implemented in code on `fieldview-architecture-migration`; end-to-end Preview validation remains pending.

## Decision

The remote-session Durable Object does not use alarms, durable leases, heartbeat messages, or periodic storage writes. It has at most two participants (controller and display), so accepted hibernatable WebSockets are the presence registry.

- The Durable Object checks its accepted WebSocket set and filters to `readyState === OPEN` to enforce one active socket per role; closed sockets are not treated as participants.
- Role and per-connection token are stored as WebSocket attachments, which survive WebSocket hibernation.
- Signaling is validated and forwarded directly to the opposite role.
- A reconnect using the same in-memory `RemotePeer` token replaces that peer's previous socket. A different token cannot take over an occupied role.
- The Worker explicitly selects `fieldview.remote.v1` as the negotiated WebSocket subprotocol; the role and token remain in the offered protocol list, not the URL.
- The browser converts the configured runtime HTTP(S) base URL to WS(S) before opening the socket.
- There is no session-state persistence, alarm scheduling, alarm cleanup, or browser heartbeat traffic.
- The DO can hibernate while connections remain open; incoming WebSocket events reactivate it.

## Resource rationale

FieldView's `row_written` allowance is scarce. This object has no reason to schedule alarms, maintain durable leases, or periodically write session metadata. Those operations would spend budget without adding useful correctness for a two-participant transient signaling room.

The remote-session runtime therefore must not call `storage.put`, `storage.delete`, `storage.setAlarm`, or `storage.deleteAlarm`. Tests make those methods fail if called. Application-level heartbeats are also removed because they existed only to renew durable leases. This is a hard default for future FieldView Durable Objects too: no alarm or periodic write without a demonstrated requirement and explicit design review.

## Tradeoff

An abandoned pairing code has no persistent record to clean up. Once both sockets close, the object has no session state to retain. A live but network-partitioned WebSocket remains present until the platform closes it. A reconnect from the same peer token can replace that stale connection; a new client with a different token receives a conflict while the previous connection is still considered open. This avoids heartbeat traffic but means a browser reload that loses its token may need to wait for the old connection to close. If real usage demonstrates that this is a problem, evaluate a protocol-level recovery mechanism before introducing alarms or persistence.

## Validation boundary

This change is source-only. It does not deploy a Worker, provision a Durable Object namespace, modify Cloudflare resources, or change billing settings. Preview pairing, reconnection, simultaneous-role exclusivity, and hibernation behavior still require end-to-end validation.
