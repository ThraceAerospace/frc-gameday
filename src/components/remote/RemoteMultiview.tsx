"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MultiviewView from "@/components/multiview/MultiviewView";
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

  return <MultiviewView controller={controller} />;
}
