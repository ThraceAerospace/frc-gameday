"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import MultiviewStage from "@/components/multiview/MultiviewStage";
import MultiviewSettings from "@/components/multiview/MultiviewSettings";
import { useMultiviewController } from "@/components/multiview/MultiviewController";
import type { MultiviewController } from "@/components/multiview/MultiviewActions";
import { createRemoteMultiviewActions, applyRemoteMultiviewAction } from "@/lib/remote/actions";
import { RemotePeer, type RemotePeerStatus, type RemoteRole } from "@/lib/remote/webrtc";
import RemoteSurface from "./RemoteSurface";

type Props = {
  role: RemoteRole;
  events: string[];
  code: string;
  onStatus?: (status: RemotePeerStatus) => void;
};

export default function RemoteMultiview({ role, events, code, onStatus }: Props) {
  const localController = useMultiviewController({ events });
  const localControllerRef = useRef(localController);
  localControllerRef.current = localController;
  const [peerStatus, setPeerStatus] = useState<RemotePeerStatus>("connecting");

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
        onAction: (action) => {
          if (role === "display") {
            applyRemoteMultiviewAction(localControllerRef.current, action);
          }
        },
      }),
  );

  useEffect(() => {
    peer.start();
    return () => peer.close();
  }, [peer]);

  useEffect(() => {
    if (role !== "controller") return;

    for (const eventKey of localController.getState().streams) {
      peer.sendAction({
        type: "addEvent",
        event: { key: eventKey } as never,
      });
    }
  }, [localController, peer, role]);

  useEffect(() => {
    if (role !== "display") return;

    const state = localController.getState();

    for (const eventKey of state.streams) {
      peer.sendAction({
        type: "addEvent",
        event: { key: eventKey } as never,
      });

      const config = state.eventConfigs[eventKey];
      if (config) {
        peer.sendAction({
          type: "setEventViewConfig",
          eventKey,
          config,
        });
      }

      const label = state.labels[eventKey];
      if (label) {
        peer.sendAction({
          type: "registerLabel",
          eventKey,
          label,
        });
      }
    }

    peer.sendAction({
      type: "setAutoFocusMatches",
      enabled: state.autoFocusMatches,
    });

    if (state.layoutKey !== null) {
      peer.sendAction({
        type: "setLayout",
        layoutKey: state.layoutKey,
      });
    }

    const order = [...state.streams];
    for (let targetPosition = 0; targetPosition < state.priority.length; targetPosition += 1) {
      const eventKey = state.priority[targetPosition];
      const currentPosition = order.indexOf(eventKey);

      if (currentPosition === -1) continue;

      for (let position = currentPosition; position > targetPosition; position -= 1) {
        peer.sendAction({
          type: "movePriority",
          position,
          direction: -1,
        });

        [order[position - 1], order[position]] = [order[position], order[position - 1]];
      }
    }
  }, [localController, peer, role]);

  const controller = useMemo<MultiviewController>(() => {
    if (role === "display") return localController;

    return {
      getState: localController.getState,
      subscribe: localController.subscribe,
      ingestWebSocketEvent: localController.ingestWebSocketEvent,
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
    <main className="relative h-screen w-screen overflow-hidden bg-black text-white">
      <MultiviewStage controller={controller} />
      <div className="pointer-events-auto fixed left-3 top-3 z-50">
        <MultiviewSettings
          state={displayState}
          actions={controller.actions}
          triggerClassName="flex h-11 w-11 items-center justify-center rounded-xl border border-white/15 bg-white/10 text-white shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-xl transition hover:bg-white/15 active:scale-95"
          triggerTitle="Multiview settings"
        />
      </div>
    </main>
  );
}
