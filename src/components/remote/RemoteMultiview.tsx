"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import MultiviewStage from "@/components/multiview/MultiviewStage";
import MultiviewSettings from "@/components/multiview/MultiviewSettings";
import { useMultiviewController } from "@/components/multiview/MultiviewController";
import type { MultiviewController } from "@/components/multiview/MultiviewActions";
import {
  createRemoteMultiviewActions,
  applyRemoteMultiviewAction,
  type RemoteMultiviewMessage,
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
  const localController = useMultiviewController({ events });
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
              availableEvents: current.availableEvents,
              eventsLoading: current.eventsLoading,
              eventPickerOpen: false,
              eventSearch: "",
              controlsVisible: true,
              priorityEditKey: null,
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

      peerRef.current?.sendMessage({
        type: "stateSnapshot",
        state: {
          ...state,
          eventConfigs: Object.fromEntries(
            Object.entries(state.eventConfigs).map(([eventKey, config]) => [
              eventKey,
              { ...config, command: null },
            ]),
          ),
        },
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

  const controller = useMemo<MultiviewController>(() => {
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

  return (
    <>
      <MultiviewStage controller={controller} className="fixed inset-0" />
      <div className="pointer-events-auto fixed left-3 top-3 z-50">
        <MultiviewSettings
          state={displayState}
          actions={controller.actions}
          triggerClassName="flex h-11 w-11 items-center justify-center rounded-xl border border-white/15 bg-white/10 text-white shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-xl transition hover:bg-white/15 active:scale-95"
          triggerTitle="Multiview settings"
        />
      </div>
    </>
  );
}
