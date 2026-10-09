# FieldView Architecture

## Purpose

This document defines the architectural model for the complete FieldView rebuild.

The central rule is:

> **Views display. States are shared. Surfaces contain Views. SurfaceControllers control Surfaces.**

Existing components should be migrated into this model rather than preserving their current responsibilities merely because they already exist.

## 1. Core Vocabulary

### View

Anything whose primary responsibility is displaying event or application data to the user ends in `View`.

Examples: `EventStreamView`, `EventDataPanelView`, `MatchView`, `ScheduleView`, `TeamView`, `StatboticsView`.

A View is presentation. It receives the State it needs, renders that State, and may expose user interactions. It does not own shared domain data, networking, polling, or remote transport.

### State

Anything that must be shared by multiple Views is represented by a `State`.

Examples: `EventState`, future `MatchState`, future `TeamState`, and Surface configuration state.

An `EventState` can be consumed by `EventStreamView`, `EventDataPanelView`, `MatchView`, `ScheduleView`, and multiple Surfaces at once. State is not a React component and is not tied to one View.

State represents the authoritative client-side representation of information needed by Views.

### EventState owns event data acquisition

`EventState` is an **active owner** of the complete client-side data lifecycle for one event. It owns all acquisition and synchronization for that event, including:

- initial data acquisition
- realtime update handling
- freshness tracking
- invalidation/reconciliation
- upstream refetching
- fallback timing
- synchronization lifecycle

An EventState is not a passive data container waiting for another data layer to fetch its data.

All event data needed by Views for a given event belongs to that event's EventState. Views must not independently fetch, poll, or subscribe to the same event data.

### Surface

Every UI parent/container that hosts one or more Views is a `Surface`.

Examples include `TileViewSurface` and future dedicated display surfaces.

The existing Multiview stage is therefore redefined as a `TileViewSurface`.

A Surface determines the presentation environment in which Views are displayed. It does not own the domain data displayed by those Views.

### SurfaceController

A `SurfaceController` owns the actions and configuration of a Surface.

Examples include adding/removing Views, changing which View is displayed, changing layout, changing View configuration, reordering Views, changing display settings, refreshing Views, and controlling webcast behavior where appropriate.

User input goes through the controller rather than directly mutating Surface state.

```text
User → SurfaceController → Surface state/configuration → Surface → View
```

## 2. Local and Remote Surface Controllers

A SurfaceController may be local or remote.

`LocalSurfaceController` executes actions against a Surface in the same client/runtime.

`RemoteSurfaceController` is a proxy for a Surface controlled somewhere else.

```text
Controller device
User
  ↓
RemoteSurfaceController
  ↓ remote transport
LocalSurfaceController
  ↓
TileSurface
  ↓
Views
```

The remote transport is an implementation detail. WebRTC is the transport currently being carried forward from the working prototype, but the Surface architecture must not depend on WebRTC.

**Invariant:** a remote action must enter the same controller/action path as a local action.

## 3. Domain State vs Surface State

These are intentionally separate.

### Domain State

Domain State describes the information being displayed: event data, matches, teams, alliances, webcast metadata, and future Statbotics data.

Domain State can be consumed by many Views and many Surfaces. There must not be a separate copy merely because Views are rendered in different places.

### Surface State

Surface State describes what a Surface is doing: active View, View collection, tile layout, View ordering, selected event, View-specific configuration, display preferences, and transient Surface commands.

This belongs to the SurfaceController/state model, not `EventState`.

Keeping these separate prevents event data from becoming entangled with display configuration.

## 4. Settings

Settings are a special case because they control a Surface rather than simply displaying domain data.

The preferred model is a Surface-attached settings View such as `SurfaceSettingsView` or `TileSurfaceSettingsView`.

```text
TileSurface
 ├── Views
 │    ├── EventStreamView
 │    └── EventDataPanelView
 │
 └── TileSurfaceSettingsView
        ↓
   TileSurfaceController
```

The settings UI must not bypass the controller and mutate Surface state directly.

If settings configure a particular View, the SurfaceController exposes the appropriate action/configuration operation for that View. The settings UI should not reach into the View's internal implementation.

Settings therefore belong to the Surface instance they control, rather than being global to a View type.

## 5. Views Must Not Own Data Acquisition

The old architecture allowed components such as `EventView` and hooks such as `useMatches` to become owners of networking and polling. The new architecture explicitly forbids this.

Views do not create independent acquisition lifecycles because they need the same data.

```text
TBA / Redis / Server WebSocket
             ↓
       EventWebSocketManager
             ↓
        EventState
             ↓
    ┌────────┴────────┐
    ↓                 ↓
EventStreamView  EventDataPanelView
```

Views subscribe to State. They do not create independent polling loops, WebSocket connections, or upstream requests for shared event data.

## 6. Client Event Data Architecture

The browser maintains one shared physical event-data WebSocket for the lifetime of the client runtime.

The WebSocket connection is shared by every EventState in that client:

```text
                    ONE physical WebSocket
                           │
                           ▼
                EventWebSocketManager
                  /         |         \
                 /          |          \
                ▼           ▼           ▼
          EventState A  EventState B  EventState C
                │           │           │
                ▼           ▼           ▼
              Views       Views       Views
```

There is **exactly one physical event-data WebSocket per browser/client runtime**. It is not created per View, per hook, or per EventState.

The shared `EventWebSocketManager` owns only the transport connection and routing of messages to the appropriate EventState. It does not own event data, freshness, refetching, or fallback logic.

Each EventState subscribes to the shared connection for its event and remains responsible for its complete event lifecycle:

- handling realtime messages for its event
- updating its event data
- tracking freshness
- maintaining its own fallback timer
- refetching its own event data upstream when necessary
- reconciling after missed or stale realtime updates

```text
WebSocket update for Event A
            ↓
EventWebSocketManager
            ↓
EventState A
            ├── update data
            ├── update freshness
            └── reset Event A fallback timer

No update for Event A for too long
            ↓
EventState A fallback timer
            ↓
EventState A refetches Event A upstream
```

Event A becoming stale does not cause Event B or Event C to refetch.

### WebSocket lifetime

The shared WebSocket is intentionally **not closed when the last EventState unsubscribes**.

Once the client runtime establishes the connection, it remains open for the lifetime of that runtime. There is no reference-counted idle shutdown and no connection churn caused by EventState mounting/unmounting.

If the physical connection fails, the shared WebSocket manager reconnects it. Existing EventStates remain subscribed to the manager and do not independently create replacement connections.

When the browser/client runtime itself disappears, the runtime naturally terminates the connection.

This gives the architecture a simple invariant:

> **EventStates subscribe and unsubscribe from event routing, but they never create or destroy the physical event-data WebSocket.**

The WebSocket manager is shared transport infrastructure. EventState remains the owner of event data acquisition.

## 7. Data Infrastructure

The UI architecture does not eliminate the server data layer.

```text
TBA
 ↓
Server data/cache layer
 ├── Redis cache
 ├── cache race protection
 ├── ETag / 304 handling
 ├── tag invalidation
 └── webhook mutation
 ↓
Server realtime layer
 ↓
ONE client WebSocket
 ↓
EventWebSocketManager
 ├── routes Event A → EventState A
 ├── routes Event B → EventState B
 └── routes Event C → EventState C
```

Redis remains infrastructure rather than UI state. The client EventState is not a substitute for Redis: Redis is server-side cache/fan-out infrastructure, while EventState is the active client-side owner of the event data lifecycle consumed by the UI.

## 8. Actions and Commands

An action represents something a user can ask a Surface to do.

Examples: `addView`, `removeView`, `setLayout`, `moveView`, `setViewConfig`, `refreshView`, and `reloadStream`.

Actions should have a stable, serializable representation wherever remote control may be required.

```text
Local input ───────────────┐
                           ↓
                    SurfaceController
                           ↓
                    action application
                           ↑
Remote input → transport ──┘
```

A remote message should describe an action, not an implementation-specific React operation.

## 9. Controller Authority

A Surface should have one authoritative controller/state path at a time.

A remote controller is a proxy that requests actions from the authoritative Surface controller.

```text
RemoteSurfaceController
        ↓ action
Authoritative LocalSurfaceController
        ↓
Surface State
        ↓
TileSurface
```

The display should not have two competing independent state owners.

When authoritative Surface state changes, the remote side may receive a state snapshot or state-change notification as appropriate. This preserves the existing remote Multiview principle that the display remains authoritative for its display state.

## 10. Transport Is Not Architecture

WebRTC, WebSocket, BroadcastChannel, or another transport must remain replaceable.

The architecture depends on controller actions, state synchronization, and connection/session semantics, not on a particular transport.

The existing WebRTC implementation is therefore treated as a transport implementation, not as the definition of remote control.

The **event-data WebSocket** described in Section 6 is an explicit shared client infrastructure component. Its single-connection requirement is an implementation invariant of the event-data architecture, not a requirement that all application transports use WebSocket.

## 11. Sessions and Multiple Surfaces

A future viewing session may contain multiple Surfaces.

```text
ViewingSession
 ├── TileSurface
 │    ├── EventStreamView
 │    └── EventDataPanelView
 │
 ├── TileSurface
 │    └── MatchView
 │
 └── dedicated Surface
      └── StatboticsView
```

A session should not become a giant universal context simply because multiple Surfaces exist. The session abstraction should be introduced around actual multi-Surface requirements.

For now, Surface + SurfaceController is the fundamental boundary.

## 12. What Does Not Belong in These Types

### Views should not own

- TBA requests
- Redis access
- WebSocket connections
- polling loops
- shared event data
- remote transport
- another View's state

### States should not own

- JSX
- presentation layout
- Surface-specific UI behavior

An EventState does own its event-data acquisition and synchronization lifecycle. It should not own the physical shared WebSocket connection itself; it subscribes to the shared WebSocket manager.

### Surfaces should not own

- TBA business logic
- independent copies of domain data
- remote transport implementation

### SurfaceControllers should not own

- JSX
- direct DOM manipulation
- data fetching merely to render a View
- transport-specific message handling

### Remote transports should not own

- application state
- View rendering
- business logic
- direct React state mutation

## 13. Naming Rules

The following naming rules are architectural constraints, not merely stylistic preferences.

| Concept | Naming |
| --- | --- |
| UI data presentation | `*View` |
| Shared application/domain data | `*State` |
| UI parent/container | `*Surface` |
| Surface action/control logic | `*SurfaceController` |
| Remote Surface proxy | explicit remote SurfaceController name |
| Local Surface controller | explicit local Surface controller name |

Examples: `EventState`, `EventStreamView`, `EventDataPanelView`, `TileViewSurface`, `TileSurfaceController`, `TileSurfaceSettingsView`.

## 14. Migration Rule

Existing components should not be renamed merely to satisfy the naming convention.

Each existing component must first have its responsibilities identified and then be moved into the appropriate architectural boundary.

For example, the current Multiview stage becomes a `TileViewSurface`, and the existing Multiview controller/action work becomes the proven implementation concept for `TileSurfaceController`.

The goal is not to preserve Multiview-specific architecture. The goal is to generalize the successful controller/action model so the architecture is no longer specifically about Multiview.

## 15. Core Architectural Invariants

1. **Views display data; they do not acquire shared data.**
2. **Shared data is represented by State.**
3. **Each EventState owns all acquisition and synchronization for its event.**
4. **An EventState is an active owner of its event lifecycle, not a passive data container.**
5. **Surfaces contain Views.**
6. **Surfaces are controlled through SurfaceControllers.**
7. **User actions enter through SurfaceControllers.**
8. **Remote actions use the same action path as local actions.**
9. **Remote transport never directly manipulates Surface React state.**
10. **Domain State is independent of Surface configuration.**
11. **One client maintains exactly one physical event-data WebSocket.**
12. **The shared event-data WebSocket remains open for the lifetime of the client runtime.**
13. **EventStates subscribe to shared WebSocket routing; they do not create or destroy the physical connection.**
14. **The shared WebSocket manager owns transport and routing only, not event data or acquisition policy.**
15. **Each EventState owns its own freshness and fallback timer.**
16. **A stale EventState refetches only its own event upstream.**
17. **Redis is server-side infrastructure, not the UI's State.**
18. **Transport implementations remain replaceable.**
19. **Settings for a Surface operate through that Surface's controller.**
20. **A Surface has one authoritative state/controller path.**
21. **Generic abstractions should be introduced only when real product requirements justify them.**

## 16. Target Architecture

```text
                         TBA
                          ↓
                   HTTP / Webhooks
                          ↓
                    Redis / Server
                          ↓
                    Server WebSocket
                          ↓
                ONE client WebSocket
                          ↓
             EventWebSocketManager
                    /      |      \
                   /       |       \
                  ▼        ▼        ▼
             EventState A EventState B EventState C
                  │        │        │
            fallback   fallback   fallback
                  │        │        │
             upstream  upstream  upstream
              refetch   refetch   refetch
                  │        │        │
                  ▼        ▼        ▼
                Views    Views    Views
                  \        |       /
                   \       |      /
                    ▼      ▼     ▼
                       Surfaces
                           ↓
                  SurfaceController
                    ┌──────┴──────┐
                    ↓             ↓
                 Local        Remote Proxy
                 control        control
                                  ↓
                               transport
                                  ↓
                         authoritative Surface
```

The architecture is deliberately layered:

**Server data → Shared client transport → EventState → View → Surface → SurfaceController → User/Remote Control**

The important ownership boundaries are:

- **Server data/cache layer:** server-side cache and upstream integration.
- **Shared client WebSocket manager:** one physical connection and message routing.
- **EventState:** all acquisition, synchronization, freshness, fallback, and event data for one event.
- **View:** presentation.
- **Surface:** UI containment and presentation environment.
- **SurfaceController:** user-facing Surface actions and configuration.
- **Remote transport:** transport of controller actions/state synchronization, never direct React manipulation.


## 9. Remote event-data ownership

For a connected remote session, the controller is the owner of live event acquisition. It subscribes to the shared local EventState instances and publishes their snapshots over the remote data channel. A remote display consumes those snapshots through EventStateSnapshotsProvider; its useEventState calls are read-only and must not create EventState instances or start duplicate TBA polling/WebSocket subscriptions.

The display remains authoritative for its surface configuration at connection and reconnect: it sends a state snapshot to the controller, after which controller actions update that configuration. The controller then sends the current event snapshots back to the display. Event snapshots and surface configuration remain separate message types.

A standalone local surface (including /event/[event]/insights) can host its own EventState in its browser runtime. It does not persist that runtime across refreshes. The stop-on-zero-subscribers lifecycle remains in effect; retained subscribers should not be torn down and recreated merely because another event is added to a surface.


## 10. Multiple remote displays and display modes

The controller can manage multiple physical displays by connecting to each display's unique six-digit pairing code. Each code remains a one-controller/one-display signaling session; multiple displays are represented as multiple peer connections in the controller browser. Every peer has its own surface controller and configuration, while event acquisition is shared through the controller browser's per-event EventState registry.

The controller keeps inactive display sessions mounted and hides their presentation instead of disconnecting them. This preserves each session's runtime configuration and peer connection while the operator switches between display tabs. Removing a display unmounts its session and releases its event subscriptions normally.

Each display has its own presentation mode (`gameday` or `insights`) and, for Match Insights, a selected event key. The display reports its current mode alongside its surface snapshot after connection/reconnection; the controller then owns subsequent changes and sends mode updates to that display. The Gameday surface and Match Insights view remain mounted on the display, with one hidden, to avoid reloading stream iframes when switching modes.
