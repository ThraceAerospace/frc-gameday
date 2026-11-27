# Remote-session lifecycle

RemoteSessionRuntime owns pairing-scoped WebRTC signaling between a controller and a display. It is a transient signaling room, not a durable application-data store.

## Connection model

- A session has at most two participants: controller and display.
- The Durable Object's accepted hibernatable WebSocket set is the presence registry.
- The runtime filters sockets by `readyState === OPEN` and enforces one active socket per role.
- Role and per-connection token are stored as WebSocket attachments and survive WebSocket hibernation.
- Signaling messages are validated and forwarded directly to the opposite role.
- A reconnect using the same in-memory `RemotePeer` token replaces that peer's previous socket. A different token cannot take over an occupied role.
- The controller coalesces concurrent `peer-ready` notifications so simultaneous reconnects do not create overlapping WebRTC offers.
- The Worker explicitly selects `fieldview.remote.v1` as the negotiated WebSocket subprotocol; role and token remain in the offered protocol list, not the URL.
- The browser converts the configured runtime HTTP(S) base URL to WS(S) before opening the socket.

## Persistence and lifecycle

The runtime does not persist session state, maintain durable leases, send application heartbeats, schedule alarms, or periodically write storage. WebSocket attachments preserve the minimal connection metadata needed across hibernation. Incoming WebSocket events reactivate the object.

An abandoned pairing code has no persistent record to clean up. Once both sockets close, no session state remains to retain. A network-partitioned but still-open socket remains present until the platform closes it. Reconnection with the same peer token can replace that socket; a client that loses its token may need to wait for the prior connection to close.

Do not introduce alarms, heartbeat writes, or durable presence leases without a demonstrated product requirement and a separately reviewed design. This transient session model is not a reason to add alarm polling to EventRuntime or TeamRuntime.

## Operational boundary

The Worker exposes remote signaling through `/remote/ws` and routes the pairing code to RemoteSessionRuntime. The session runtime owns signaling only; durable event/team data and application realtime remain separate runtime concerns.
