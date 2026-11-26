"use client";

import { useEffect, useState } from "react";
import RemoteSession from "@/components/remote/RemoteSession";
import type {
  RemotePeerStatus,
  RemoteSignalingStatus,
} from "@/lib/remote/webrtc";

type Props = {
  events?: string[];
  compact?: boolean;
  showReconnectStatus?: boolean;
};

function createPairingCode() {
  const range = 900_000;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return String(100_000 + (values[0] % range));
}

export default function RemoteDisplaySession({
  events = [],
  compact = false,
  showReconnectStatus = false,
}: Props) {
  const [code, setCode] = useState<string | null>(null);
  const [peerStatus, setPeerStatus] = useState<RemotePeerStatus>("connecting");
  const [signalingStatus, setSignalingStatus] =
    useState<RemoteSignalingStatus>("connecting");
  const [hasConnected, setHasConnected] = useState(false);

  useEffect(() => {
    setCode(createPairingCode());
  }, []);

  const connected = peerStatus === "connected";

  return (
    <>
      {code && compact && (
        <div className="pointer-events-none fixed right-3 top-3 z-50 rounded-xl border border-white/15 bg-black/75 px-3 py-2 text-white shadow-lg backdrop-blur-xl">
          <div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-neutral-400">
            Remote control code
          </div>
          <div className="mt-0.5 text-2xl font-bold tracking-[0.18em]">
            {code}
          </div>
        </div>
      )}

      {code && !compact && !hasConnected && (
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

      {code && showReconnectStatus && !compact && hasConnected && !connected && (
        <div className="pointer-events-none fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-xl border border-white/15 bg-black/60 px-3 py-2 text-xl text-neutral-300 shadow-lg backdrop-blur-xl">
          <span className="font-semibold tracking-[0.12em] text-white">
            {code}
          </span>
          <span className="mx-2 text-neutral-600">•</span>
          <span>
            {signalingStatus === "connected" ? "Ready to reconnect" : "Reconnecting"}
          </span>
        </div>
      )}

      {code && (
        <RemoteSession
          role="display"
          events={events}
          useLocalCanonicalSnapshots={compact}
          code={code}
          onStatus={(status: RemotePeerStatus) => {
            setPeerStatus(status);
            if (status === "connected") setHasConnected(true);
          }}
          onSignalingStatus={setSignalingStatus}
        />
      )}
    </>
  );
}
