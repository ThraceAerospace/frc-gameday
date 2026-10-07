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

State represents the authoritative client-side representation of information needed by Views. Acquisition, synchronization, invalidation, and freshness are infrastructure responsibilities rather than View responsibilities.

### Surface

Every UI parent/container that hosts one or more Views is a `Surface`.

Examples include `TileSurface` and future dedicated display surfaces.

The existing Multiview stage is therefore redefined as a `TileSurface`.

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

```text
TBA / Redis / WebSocket
          ↓
      Data layer
          ↓
      EventState
          ↓
   ┌──────┴──────┐
   ↓             ↓
EventStreamView  EventDataPanelView
```

Views subscribe to State. They do not create independent polling loops because they need the same data.

## 6. Client Event Data Architecture

The browser should maintain one shared event-data connection and state system.

```text
TBA / Redis
     ↓
Server WebSocket
     ↓
Client Event Store / Event Hub
     ├── EventState A
     ├── EventState B
     └── EventState C
             ↓
           Views
```

There should be one WebSocket per browser/client rather than one WebSocket per View or per event hook.

Each EventState independently tracks freshness and synchronization status. The Event Store/Hub owns subscriptions, WebSocket lifecycle, event routing, initial data acquisition, invalidation/refetch, fallback freshness, and synchronization status.

Views only subscribe to the resulting State.

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
Client Event Store
 ↓
EventState
 ↓
Views
```

Redis remains infrastructure rather than UI state. The client EventState is not a substitute for Redis: Redis is server-side cache/fan-out infrastructure, while EventState is the client-side representation consumed by the UI.

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
- browser transport details
- Surface-specific UI behavior

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
| Local Surface controller | explicit local SurfaceController name |

Examples: `EventState`, `EventStreamView`, `EventDataPanelView`, `TileSurface`, `TileSurfaceController`, `TileSurfaceSettingsView`.

## 14. Migration Rule

Existing components should not be renamed merely to satisfy the naming convention.

Each existing component must first have its responsibilities identified and then be moved into the appropriate architectural boundary.

For example, the current Multiview stage becomes a `TileSurface`, and the existing Multiview controller/action work becomes the proven implementation concept for `TileSurfaceController`.

The goal is not to preserve Multiview-specific architecture. The goal is to generalize the successful controller/action model so the architecture is no longer specifically about Multiview.

## 15. Core Architectural Invariants

1. **Views display data; they do not acquire shared data.**
2. **Shared data is represented by State.**
3. **Surfaces contain Views.**
4. **Surfaces are controlled through SurfaceControllers.**
5. **User actions enter through SurfaceControllers.**
6. **Remote actions use the same action path as local actions.**
7. **Remote transport never directly manipulates Surface React state.**
8. **Domain State is independent of Surface configuration.**
9. **One client should maintain one shared realtime event-data connection.**
10. **Per-event freshness is tracked independently.**
11. **Redis is server-side infrastructure, not the UI's State.**
12. **Transport implementations remain replaceable.**
13. **Settings for a Surface operate through that Surface's controller.**
14. **A Surface has one authoritative state/controller path.**
15. **Generic abstractions should be introduced only when real product requirements justify them.**

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
                 Client Event Store
                          ↓
                      EventState
                    ┌─────┴─────┐
                    ↓           ↓
              EventStreamView  EventDataPanelView
                    │           │
                    └─────┬─────┘
                          ↓
                       Surface
                          ↓
                 SurfaceController
                    ┌─────┴─────┐
                    ↓           ↓
                 Local       Remote Proxy
                control       control
                                  ↓
                               transport
                                  ↓
                           authoritative Surface
```

The architecture is deliberately layered:

**Data → State → View → Surface → Controller → User/Remote Control**

The controller is the action boundary; State is the shared-data boundary; View is the presentation boundary; and Surface is the display/container boundary.