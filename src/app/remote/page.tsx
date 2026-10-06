"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import RemoteMultiview from "@/components/remote/RemoteMultiview";
import type { RemotePeerStatus } from "@/lib/remote/webrtc";

export default function RemotePage() {
  const searchParams = useSearchParams();
  const events = searchParams.getAll("event");
  const [code, setCode] = useState("");
  const [connected, setConnected] = useState(false);

  if (!connected) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black text-white">
        <form
          className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-6"
          onSubmit={(event) => {
            event.preventDefault();
            const normalized = code.trim();

            if (/^\d{6}$/.test(normalized)) {
              setCode(normalized);
              setConnected(true);
            }
          }}
        >
          <div>
            <h1 className="text-lg font-semibold">FieldView Remote</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Enter the six-digit code shown on the display.
            </p>
          </div>

          <input
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            className="rounded-lg border border-white/10 bg-black px-4 py-3 text-center text-2xl tracking-[0.35em] outline-none"
          />

          <button
            type="submit"
            disabled={code.length !== 6}
            className="rounded-lg bg-white px-4 py-3 font-semibold text-black disabled:opacity-30"
          >
            Connect
          </button>
        </form>
      </main>
    );
  }

  return (
    <RemoteMultiview
      role="controller"
      events={events}
      code={code}
      onStatus={(status: RemotePeerStatus) => {
        if (status === "disconnected" || status === "error") {
          setConnected(false);
        }
      }}
    />
  );
}
