"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import TileViewSurface from "@/components/surface/TileViewSurface";
import { useTileSurfaceController } from "@/components/surface/TileSurfaceController";
import type { TileSurfaceController } from "@/components/surface/TileSurfaceActions";
import { subscribeEventState } from "@/lib/events/useEventState";
import { EventStateSnapshotsProvider } from "@/lib/events/EventStateSnapshotsProvider";
import type { EventStateSnapshot } from "@/lib/events/EventState";
import {
  createRemoteSessionActions,
  applyRemoteSessionAction,
  type RemoteSessionMessage,
  type RemoteSurfaceState,
} from "@/lib/remote/actions";
import {
  RemotePeer,
  type RemotePeerStatus,
  type RemoteRole,
  type RemoteSignalingStatus,
} from "@/lib/remote/webrtc";
import RemoteTileSurface from "./RemoteTileSurface";
import EventInsightsSurface from "@/components/surface/EventInsightsSurface";
import { resolveActiveEventKey } from "@/lib/surface/resolveActiveEventKey";

type Props = {
  role: RemoteRole;
  events: string[];
  code: string;
  onStatus?: (status: RemotePeerStatus) => void;
  onSignalingStatus?: (status: RemoteSignalingStatus) => void;
  hidden?: boolean;
  controller?: TileSurfaceController;
};

export default function RemoteSession({
  role,
  events,
  code,
  onStatus,
  onSignalingStatus,
  hidden = false,
  controller: sharedController,
}: Props) {
  const localController = useTileSurfaceController({ events, controller: sharedController });
  const localControllerRef = useRef(localController);
  localControllerRef.current = localController;
  const peerRef = useRef<RemotePeer | null>(null);

  const [peerStatus, setPeerStatus] =
    useState<RemotePeerStatus>("connecting");
  const [eventStates, setEventStates] = useState<Record<string, EventStateSnapshot>>({});
  const [displayMode, setDisplayMode] = useState<"gameday" | "insights">("gameday");
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  const eventStatesRef = useRef<Record<string, EventStateSnapshot>>({});
  const eventSubscriptionsRef = useRef(new Map<string, () => void>());
  const sendControllerState = useMemo(
    () => (includeEventStates = false) => {
      if (role !== "controller") return;
      const state = localControllerRef.current.getState();
      const {
        eventPickerOpen,
        eventSearch,
        availableEvents,
        eventsLoading,
        controlsVisible,
        priorityEditKey,
        ...surfaceState
      } = state;
      void eventPickerOpen;
      void eventSearch;
      void availableEvents;
      void eventsLoading;
      void controlsVisible;
      void priorityEditKey;
      const snapshot: RemoteSurfaceState = {
        ...surfaceState,
        eventConfigs: Object.fromEntries(
          Object.entries(surfaceState.eventConfigs).map(([eventKey, config]) => [
            eventKey,
            { ...config, command: null },
          ]),
        ),
      };
      peerRef.current?.sendMessage({ type: "stateSnapshot", state: snapshot });
      peerRef.current?.sendMessage({
        type: "displayModeSnapshot",
        mode: displayModeRef.current,
      });
      if (includeEventStates) {
        for (const [eventKey, eventState] of Object.entries(eventStatesRef.current)) {
          peerRef.current?.sendMessage({
            type: "eventStateSnapshot",
            eventKey,
            state: eventState,
          });
        }
      }
    },
    [role],
  );

  const surfaceState = useSyncExternalStore(
    localController.subscribe,
    localController.getState,
    localController.getState,
  );

  const handleStatus = (status: RemotePeerStatus) => {
    setPeerStatus(status);
    onStatus?.(status);
    if (status === "connected" && role === "controller") {
      sendControllerState(true);
    }
  };

  const [peer] = useState(
    () =>
      new RemotePeer({
        code,
        role,
        onStatus: handleStatus,
        onSignalingStatus,
        onAction: (action) => {
          applyRemoteSessionAction(localControllerRef.current, action);
        },
        onMessage: (message: RemoteSessionMessage) => {
          if (message.type === "displayModeSnapshot") {
            setDisplayMode(message.mode);
            return;
          }

          if (message.type === "eventStateSnapshot" && role === "display") {
            setEventStates((current) => {
              const next = {
                ...current,
                [message.eventKey]: message.state,
              };
              eventStatesRef.current = next;
              return next;
            });
            return;
          }

          if (message.type === "stateSnapshot" && role === "display") {
            const current = localControllerRef.current.getState();
            localControllerRef.current.replaceState({
              ...message.state,
              eventPickerOpen: current.eventPickerOpen,
              eventSearch: current.eventSearch,
              availableEvents: current.availableEvents,
              eventsLoading: current.eventsLoading,
              controlsVisible: current.controlsVisible,
              priorityEditKey: current.priorityEditKey,
            });
          }
        },
      }),
  );

  peerRef.current = peer;

  useEffect(() => {
    if (role !== "controller") return;

    const eventKeys = new Set(
      localControllerRef.current.getState().streams.map(
        (tileId) => localControllerRef.current.getState().tileEvents[tileId] ?? tileId,
      ),
    );

    for (const [eventKey, unsubscribe] of eventSubscriptionsRef.current) {
      if (!eventKeys.has(eventKey)) {
        unsubscribe();
        eventSubscriptionsRef.current.delete(eventKey);
        setEventStates((current) => {
          const next = { ...current };
          delete next[eventKey];
          eventStatesRef.current = next;
          return next;
        });
      }
    }

    for (const eventKey of eventKeys) {
      if (eventSubscriptionsRef.current.has(eventKey)) continue;

      const unsubscribe = subscribeEventState(eventKey, (state) => {
        const next = {
          ...eventStatesRef.current,
          [eventKey]: state,
        };
        eventStatesRef.current = next;
        setEventStates(next);
        peerRef.current?.sendMessage({
          type: "eventStateSnapshot",
          eventKey,
          state,
        });
      });

      eventSubscriptionsRef.current.set(eventKey, unsubscribe);
    }
  }, [role, surfaceState.streams, surfaceState.tileEvents]);

  useEffect(() => () => {
    for (const unsubscribe of eventSubscriptionsRef.current.values()) {
      unsubscribe();
    }
    eventSubscriptionsRef.current.clear();
  }, []);



  useEffect(() => {
    peer.start();
    return () => peer.close();
  }, [peer]);

  useEffect(() => {
    if (role !== "controller") return;
    return localController.subscribe(() => sendControllerState());
  }, [localController, role, sendControllerState]);

  const controller = useMemo<TileSurfaceController>(() => ({
    getState: localController.getState,
    replaceState: localController.replaceState,
    subscribe: localController.subscribe,
    actions: role === "display"
      ? createRemoteSessionActions(localController, (action) => peer.sendAction(action))
      : localController.actions,
  }), [localController, peer, role]);

  if (role === "controller") {
    return (
      <div hidden={hidden}>
        <RemoteTileSurface
          controller={controller}
          peerStatus={peerStatus}
          eventStates={eventStates}
          displayMode={displayMode}
          onDisplayModeChange={(mode) => {
            setDisplayMode(mode);
            peer.sendMessage({ type: "displayModeSnapshot", mode });
          }}
        />
      </div>
    );
  }

  const displayState = surfaceState;
  const resolvedInsightsEventKey = resolveActiveEventKey(displayState);
  const trackedTeams = resolvedInsightsEventKey
    ? displayState.eventConfigs[resolvedInsightsEventKey]?.trackedTeams ?? []
    : [];

  return (
    <EventStateSnapshotsProvider snapshots={eventStates}>
      <div hidden={hidden}>
        <div hidden={displayMode !== "gameday"}>
          <TileViewSurface controller={controller} showModeToggle={false} />
        </div>
        <div hidden={displayMode !== "insights"}>
          {resolvedInsightsEventKey ? (
            <EventInsightsSurface eventKey={resolvedInsightsEventKey} trackedTeams={trackedTeams} />
          ) : (
            <main className="flex min-h-screen items-center justify-center bg-black p-8 text-center text-sm text-neutral-500">
              Add an event from the controller before switching this display to Match Insights.
            </main>
          )}
        </div>
      </div>
    </EventStateSnapshotsProvider>
  );
}
