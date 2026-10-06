"use client";

import { useEffect, useMemo, useState } from "react";
import MultiviewView from "@/components/multiview/MultiviewView";
import { useMultiviewController } from "@/components/multiview/MultiviewController";
import type { MultiviewController } from "@/components/multiview/MultiviewActions";
import { createRemoteMultiviewActions, applyRemoteMultiviewAction } from "@/lib/remote/actions";
import { RemotePeer, type RemotePeerStatus, type RemoteRole } from "@/lib/remote/webrtc";

type Props = {
  role: RemoteRole;
  events: string[];
  code: string;
  onStatus?: (status: RemotePeerStatus) => void;
};

export default function RemoteMultiview({
  role,
  events,
  code,
  onStatus,
}: Props) {
  const localController = useMultiviewController({ events });
  const [peer] = useState(
    () =>
      new RemotePeer({
        code,
        role,
        onStatus,
        onAction: (action) => {
          if (role === "display") {
            applyRemoteMultiviewAction(localControllerRef.current, action);
          }
        },
      }),
  );

  const localControllerRef = useLatest(localController);

  useEffect(() => {
    peer.start();

    return () => peer.close();
  }, [peer]);

  useEffect(() => {
    if (role !== "controller") {
      return;
    }

    for (const eventKey of localController.getState().streams) {
      peer.sendAction({
        type: "addEvent",
        event: {
          key: eventKey,
        } as never,
      });
    }
  }, [localController, peer, role]);

  const controller = useMemo<MultiviewController>(() => {
    if (role === "display") {
      return localController;
    }

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

  return <MultiviewView controller={controller} />;
}

function useLatest<T>(value: T) {
  const ref = useMemo(() => ({ current: value }), []);
  ref.current = value;
  return ref;
}
