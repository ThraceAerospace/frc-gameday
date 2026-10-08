"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import FieldViewSurface from "@/components/surface/FieldViewSurface";
import { useTileSurfaceController } from "@/components/surface/TileSurfaceController";
import type { TileSurfaceController } from "@/components/surface/TileSurfaceActions";
import { subscribeEventState } from "@/lib/events/useEventState";
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

type Props = {
  role: RemoteRole;
  events: string[];
  code: string;
  onStatus?: (status: RemotePeerStatus) => void;
  onSignalingStatus?: (status: RemoteSignalingStatus) => void;
};

export default function RemoteSession({
  role,
  events,
  code,
  onStatus,
  onSignalingStatus,
}: Props) {
  const localController = useTileSurfaceController({ events });
  const localControllerRef = useRef(localController);
  localControllerRef.current = localController;
  const peerRef = useRef<RemotePeer | null>(null);

  const [peerStatus, setPeerStatus] =
    useState<RemotePeerStatus>("connecting");
  const [eventStates, setEventStates] = useState<Record<string, EventStateSnapshot>>({});
  const eventStatesRef = useRef<Record<string, EventStateSnapshot>>({});

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
            for (const [eventKey, state] of Object.entries(eventStatesRef.current)) {
              peerRef.current?.sendMessage({
                type: "eventStateSnapshot",
                eventKey,
                state,
              });
            }
            return;
          }

          if (message.type === "eventStateSnapshot" && role === "controller") {
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
          }
        },
      }),
  );

  peerRef.current = peer;

  useEffect(() => {
    if (role !== "display") return;

    const unsubscribe = surfaceState.streams.map((eventKey) =>
      subscribeEventState(eventKey, (state) => {
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
      }),
    );

    return () => unsubscribe.forEach((stop) => stop());
  }, [role, surfaceState.streams]);

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

  const controller = useMemo<TileSurfaceController>(() => {
    if (role === "controller") {
    return (
      <RemoteTileSurface
        controller={controller}
        peerStatus={peerStatus}
        eventStates={eventStates}
      />
    );
  }

  return <FieldViewSurface controller={controller} />;
}
