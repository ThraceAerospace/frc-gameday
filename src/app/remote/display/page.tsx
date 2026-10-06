"use client";

import { useEffect, useState } from "react";
import RemoteMultiview from "@/components/remote/RemoteMultiview";
import type { RemotePeerStatus } from "@/lib/remote/webrtc";

function createPairingCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export default function RemoteDisplayPage() {
  const [code, setCode] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setCode(createPairingCode());
  }, []);

  return (
    <main className="relative min-h-screen bg-black text-white">
      {code && !connected && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black">
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

      {code && (
        <RemoteMultiview
          role="display"
          events={[]}
          code={code}
          onStatus={(status: RemotePeerStatus) => {
            setConnected(status === "connected");
          }}
        />
      )}
    </main>
  );
}
