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
import MatchInsightsView from "@/components/match/MatchInsightsView";

type Props = {
  role: RemoteRole;
  events: string[];
  code: string;
  onStatus?: (status: RemotePeerStatus) => void;
  onSignalingStatus?: (status: RemoteSignalingStatus) => void;
  hidden?: boolean;
};

export default function RemoteSession({
  role,
  events,
  code,
  onStatus,
  onSignalingStatus,
  hidden = false,
}: Props) {
  const localController = useTileSurfaceController({ events });
  const localControllerRef = useRef(localController);
  localControllerRef.current = localController;
  const peerRef = useRef<RemotePeer | null>(null);

  const [peerStatus, setPeerStatus] =
    useState<RemotePeerStatus>("connecting");
  const [eventStates, setEventStates] = useState<Record<string, EventStateSnapshot>>({});
  const [displayMode, setDisplayMode] = useState<"gameday" | "insights">("gameday");
  const [insightsEventKey, setInsightsEventKey] = useState<string | null>(events[0] ?? null);
  const eventStatesRef = useRef<Record<string, EventStateSnapshot>>({});
  const eventSubscriptionsRef = useRef(new Map<string, () => void>());

  const surfaceState = useSyncExternalStore(
    localController.subscribe,
    localController.getState,
    localController.getState,
  );

  const handleStatus = (status: RemotePeerStatus) => {
    setPeerStatus(status);
    onStatus?.(status);
  };

  const [peer] = useState(
    () =>
      new RemotePeer({
        code,
        role,
        onStatus: handleStatus,
        onSignalingStatus,
        onAction: (action) => {
          if (role === "display") {
            applyRemoteSessionAction(localControllerRef.current, action);
          }
        },
        onMessage: (message: RemoteSessionMessage) => {
          if (message.type === "requestState" && role === "display") {
            sendDisplayState();
            peerRef.current?.sendMessage({
              type: "displayModeSnapshot",
              mode: displayMode,
              eventKey: insightsEventKey,
            });
            for (const [eventKey, state] of Object.entries(eventStatesRef.current)) {
              peerRef.current?.sendMessage({
                type: "eventStateSnapshot",
                eventKey,
                state,
              });
            }
            return;
          }

          if (message.type === "displayModeSnapshot") {
            setDisplayMode(message.mode);
            setInsightsEventKey(message.eventKey);
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

          if (message.type === "stateSnapshot" && role === "controller") {
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

            // The display reports its authoritative surface config on every
            // connection. Follow it with the controller's current domain snapshots.
            for (const [eventKey, state] of Object.entries(eventStatesRef.current)) {
              peerRef.current?.sendMessage({
                type: "eventStateSnapshot",
                eventKey,
                state,
              });
            }
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

  const sendDisplayState = useMemo(
    () => () => {
      if (role !== "display") return;

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

      peerRef.current?.sendMessage({
        type: "stateSnapshot",
        state: snapshot,
      });
    },
    [role],
  );

  useEffect(() => {
    peer.start();
    return () => peer.close();
  }, [peer]);

  useEffect(() => {
    if (role !== "display") return;

    return localController.subscribe(() => {
      sendDisplayState();
    });
  }, [localController, role, sendDisplayState]);

  const controller = useMemo<TileSurfaceController>(() => ({
    getState: localController.getState,
    replaceState: localController.replaceState,
    subscribe: localController.subscribe,
    actions: createRemoteSessionActions(
      localController,
      (action) => peer.sendAction(action),
    ),
  }), [localController, peer]);

  if (role === "controller") {
    return (
      <div hidden={hidden}>
        <RemoteTileSurface
          controller={controller}
          peerStatus={peerStatus}
          eventStates={eventStates}
          displayMode={displayMode}
          insightsEventKey={insightsEventKey}
          onDisplayModeChange={(mode) => {
            setDisplayMode(mode);
            const currentSurface = localController.getState();
            const nextEventKey = insightsEventKey ?? (currentSurface.streams[0] ? currentSurface.tileEvents[currentSurface.streams[0]] ?? currentSurface.streams[0] : null);
            setInsightsEventKey(nextEventKey);
            peer.sendMessage({ type: "displayModeSnapshot", mode, eventKey: nextEventKey });
          }}
          onInsightsEventKeyChange={(eventKey) => {
            setInsightsEventKey(eventKey);
            peer.sendMessage({ type: "displayModeSnapshot", mode: displayMode, eventKey });
          }}
        />
      </div>
    );
  }

  const displayState = useSyncExternalStore(
    localController.subscribe,
    localController.getState,
    localController.getState,
  );
  const resolvedInsightsEventKey =
    insightsEventKey ??
    displayState.streams.map((tileId) => displayState.tileEvents[tileId] ?? tileId)[0] ??
    null;
  const trackedTeams = resolvedInsightsEventKey
    ? displayState.eventConfigs[resolvedInsightsEventKey]?.trackedTeams ?? []
    : [];

  return (
    <EventStateSnapshotsProvider snapshots={eventStates}>
      <div hidden={hidden}>
        <div hidden={displayMode !== "gameday"}>
          <TileViewSurface controller={controller} />
        </div>
        <div hidden={displayMode !== "insights"}>
          {resolvedInsightsEventKey ? (
            <MatchInsightsView eventKey={resolvedInsightsEventKey} trackedTeams={trackedTeams} />
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
