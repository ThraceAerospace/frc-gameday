"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import TileViewSurface from "@/components/surface/TileViewSurface";
import { useTileSurfaceController } from "@/components/surface/TileSurfaceController";
import type { TileSurfaceController } from "@/components/surface/TileSurfaceActions";
import { getCanonicalEventSnapshot, subscribeCanonicalEventSnapshot } from "@/lib/events/sharedWorkerClient";
import type { CanonicalEventSnapshotData } from "@/lib/events/workerRealtime";
type CanonicalEventSnapshotValue = { version: number; snapshot: CanonicalEventSnapshotData };
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

type Props = {
  role: RemoteRole;
  events: string[];
  code: string;
  onStatus?: (status: RemotePeerStatus) => void;
  onSignalingStatus?: (status: RemoteSignalingStatus) => void;
  hidden?: boolean;
  controller?: TileSurfaceController;
  useLocalCanonicalSnapshots?: boolean;
};

export default function RemoteSession({
  role,
  events,
  code,
  onStatus,
  onSignalingStatus,
  hidden = false,
  controller: sharedController,
  useLocalCanonicalSnapshots = false,
}: Props) {
  const localController = useTileSurfaceController({ events, controller: sharedController });
  const localControllerRef = useRef(localController);
  localControllerRef.current = localController;
  const peerRef = useRef<RemotePeer | null>(null);

  const [peerStatus, setPeerStatus] =
    useState<RemotePeerStatus>("connecting");
  const [eventSnapshots, setEventSnapshots] = useState<Record<string, CanonicalEventSnapshotValue>>({});
  const eventSnapshotsRef = useRef<Record<string, CanonicalEventSnapshotValue>>({});
  const eventSubscriptionsRef = useRef(new Map<string, () => void>());
  const controllerStateInitializedRef = useRef(false);
  const peerUsesLocalCanonicalSnapshotsRef = useRef(false);
  const sendControllerState = useMemo(
    () => (includeEventSnapshots = false) => {
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
      if (includeEventSnapshots && !peerUsesLocalCanonicalSnapshotsRef.current) {
        for (const [eventKey, value] of Object.entries(eventSnapshotsRef.current)) {
          peerRef.current?.sendMessage({ type: "eventSnapshot", eventKey, ...value });
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
      if (controllerStateInitializedRef.current) {
        sendControllerState(true);
      } else {
        peerRef.current?.sendMessage({ type: "requestInitialState" });
      }
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
          if (message.type === "requestInitialState" && role === "display") {
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
            peerRef.current?.sendMessage({
              type: "initialState",
              usesLocalCanonicalSnapshots: useLocalCanonicalSnapshots,
              state: {
                ...surfaceState,
                eventConfigs: Object.fromEntries(
                  Object.entries(surfaceState.eventConfigs).map(([eventKey, config]) => [
                    eventKey,
                    { ...config, command: null },
                  ]),
                ),
              },
            });
            return;
          }

          if (message.type === "initialState" && role === "controller") {
            peerUsesLocalCanonicalSnapshotsRef.current = message.usesLocalCanonicalSnapshots === true;
            if (!controllerStateInitializedRef.current) {
              const current = localControllerRef.current.getState();
              if (current.streams.length === 0 && current.priority.length === 0) {
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
              controllerStateInitializedRef.current = true;
            }
            sendControllerState(true);
            return;
          }

          if (message.type === "eventSnapshot" && role === "display") {
            setEventSnapshots((current) => {
              const next = {
                ...current,
                [message.eventKey]: { version: message.version, snapshot: message.snapshot },
              };
              eventSnapshotsRef.current = next;
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
        setEventSnapshots((current) => {
          const next = { ...current };
          delete next[eventKey];
          eventSnapshotsRef.current = next;
          return next;
        });
      }
    }

    for (const eventKey of eventKeys) {
      if (eventSubscriptionsRef.current.has(eventKey)) continue;

      const unsubscribe = subscribeCanonicalEventSnapshot(eventKey, () => {
        const value = getCanonicalEventSnapshot(eventKey);
        if (!value) return;
        const next = {
          ...eventSnapshotsRef.current,
          [eventKey]: value,
        };
        eventSnapshotsRef.current = next;
        setEventSnapshots(next);
        peerRef.current?.sendMessage({ type: "eventSnapshot", eventKey, ...value });
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
    return localController.subscribe(() => {
      controllerStateInitializedRef.current = true;
      sendControllerState();
    });
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
          eventSnapshots={eventSnapshots}
        />
      </div>
    );
  }

  const display = (
    <div hidden={hidden}>
      <TileViewSurface controller={controller} />
    </div>
  );

  return display;
}
