"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import TileSurface from "@/components/surface/TileSurface";
import TileSurfaceSettingsView from "@/components/surface/TileSurfaceSettingsView";
import { useTileSurfaceController } from "@/components/surface/TileSurfaceController";
import type { TileSurfaceController } from "@/components/surface/TileSurfaceActions";
import {
  createRemoteMultiviewActions,
  applyRemoteMultiviewAction,
  type RemoteMultiviewMessage,
  type RemoteSurfaceState,
} from "@/lib/remote/actions";
import {
  RemotePeer,
  type RemotePeerStatus,
  type RemoteRole,
  type RemoteSignalingStatus,
} from "@/lib/remote/webrtc";
import RemoteSurface from "./RemoteSurface";

type Props = {
  role: RemoteRole;
  events: string[];
  code: string;
  onStatus?: (status: RemotePeerStatus) => void;
  onSignalingStatus?: (status: RemoteSignalingStatus) => void;
};

export default function RemoteMultiview({
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
            applyRemoteMultiviewAction(localControllerRef.current, action);
          }
        },
        onMessage: (message: RemoteMultiviewMessage) => {
          if (message.type === "requestState" && role === "display") {
            sendDisplayState();
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
      return {
        getState: localController.getState,
        replaceState: localController.replaceState,
        subscribe: localController.subscribe,
        actions: createRemoteMultiviewActions(
          localController,
          (action) => peer.sendAction(action),
        ),
      };
    }

    return {
      getState: localController.getState,
      replaceState: localController.replaceState,
      subscribe: localController.subscribe,
      actions: createRemoteMultiviewActions(
        localController,
        (action) => peer.sendAction(action),
      ),
    };
  }, [localController, peer, role]);

  if (role === "controller") {
    return <RemoteSurface controller={controller} peerStatus={peerStatus} />;
  }

  const displayState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  const [settingsVisible, setSettingsVisible] = useState(false);

  useEffect(() => {
    if (role !== "display") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "s" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLSelectElement) &&
        !(event.target instanceof HTMLButtonElement)
      ) {
        event.preventDefault();
        setSettingsVisible(true);
      }
    };

    const showSettingsButton = () => setSettingsVisible(true);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousedown", showSettingsButton);
    window.addEventListener("touchstart", showSettingsButton, { passive: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", showSettingsButton);
      window.removeEventListener("touchstart", showSettingsButton);
    };
  }, [role]);

  return (
    <>
      <TileSurface controller={controller} className="fixed inset-0" />
      {settingsVisible ? (
        <div className="pointer-events-auto fixed right-3 top-3 z-50">
          <TileSurfaceSettingsView
            state={displayState}
            actions={controller.actions}
            triggerClassName="flex h-11 w-11 items-center justify-center rounded-xl border border-white/15 bg-white/10 text-white shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-xl transition hover:bg-white/15 active:scale-95"
            triggerTitle="Multiview settings"
          />
        </div>
      ) : null}
    </>
  );
}
