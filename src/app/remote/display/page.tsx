"use client";

import { useEffect, useState } from "react";
import RemoteSession from "@/components/remote/RemoteSession";
import type {
  RemotePeerStatus,
  RemoteSignalingStatus,
} from "@/lib/remote/webrtc";

function createPairingCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export default function RemoteDisplayPage() {
  const [code, setCode] = useState<string | null>(null);
  const [peerStatus, setPeerStatus] =
    useState<RemotePeerStatus>("connecting");
  const [signalingStatus, setSignalingStatus] =
    useState<RemoteSignalingStatus>("connecting");
  const [hasConnected, setHasConnected] = useState(false);

  useEffect(() => {
    setCode(createPairingCode());
  }, []);

  const connected = peerStatus === "connected";

  return (
    <>
      {code && !hasConnected && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black text-white">
          <div className="text-center">
            <p className="text-sm uppercase tracking-[0.3em] text-neutral-500">
              FieldView Remote
            </p>
            <p className="mt-4 text-8xl font-bold tracking-[0.2em]">
              {code}
            </p>
            <p className="mt-6 text-lg text-neutral-400">
              Enter this code on the remote controller.
            </p>
          </div>
        </div>
      )}

      {code && hasConnected && !connected && (
        <div className="pointer-events-none fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-xl border border-white/15 bg-black/60 px-3 py-2 text-xl text-neutral-300 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-xl">
          <span className="font-semibold tracking-[0.12em] text-white">
            {code}
          </span>
          <span className="mx-2 text-neutral-600">•</span>
          <span>
            {signalingStatus === "connected"
              ? "Ready to reconnect"
              : "Reconnecting"}
          </span>
        </div>
      )}

      {code && (
        <RemoteSession
          role="display"
          events={[]}
          code={code}
          onStatus={(status: RemotePeerStatus) => {
            setPeerStatus(status);

            if (status === "connected") {
              setHasConnected(true);
            }
          }}
          onSignalingStatus={setSignalingStatus}
        />
      )}
    </>
  );
}
