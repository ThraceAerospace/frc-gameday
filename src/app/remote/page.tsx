"use client";

import { useState } from "react";
import RemoteSession from "@/components/remote/RemoteSession";
import type { RemotePeerStatus } from "@/lib/remote/webrtc";

type DisplaySession = {
  id: string;
  code: string;
  status: RemotePeerStatus;
};

function createId() {
  return crypto.randomUUID();
}

export default function RemotePage() {
  const [codeInput, setCodeInput] = useState("");
  const [displays, setDisplays] = useState<DisplaySession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  function addDisplay(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = codeInput.trim();
    if (!/^\\d{6}$/.test(code)) return;
    if (displays.some((display) => display.code === code)) {
      setActiveId(displays.find((display) => display.code === code)?.id ?? null);
      setCodeInput("");
      return;
    }

    const display = { id: createId(), code, status: "connecting" as const };
    setDisplays((current) => [...current, display]);
    setActiveId(display.id);
    setCodeInput("");
  }

  function updateStatus(id: string, status: RemotePeerStatus) {
    setDisplays((current) =>
      current.map((display) => display.id === id ? { ...display, status } : display),
    );
  }

  function removeDisplay(id: string) {
    setDisplays((current) => current.filter((display) => display.id !== id));
    setActiveId((current) => current === id
      ? displays.find((display) => display.id !== id)?.id ?? null
      : current);
  }

  const activeDisplay = displays.find((display) => display.id === activeId) ?? null;

  return (
    <main className="min-h-screen bg-black text-white">
      <header className="border-b border-white/10 bg-neutral-950 px-5 py-4 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">FieldView Remote Controller</h1>
            <p className="mt-1 text-sm text-neutral-500">Connect and manage multiple displays independently.</p>
          </div>
          <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-neutral-400">{displays.length} {displays.length === 1 ? "display" : "displays"}</span>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 p-5 sm:p-8 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <form onSubmit={addDisplay} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-sm font-semibold">Add a display</h2>
            <p className="mt-1 text-xs leading-5 text-neutral-500">Enter the six-digit pairing code shown on the display you want to control.</p>
            <input
              value={codeInput}
              onChange={(event) => setCodeInput(event.target.value.replace(/\\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              aria-label="Display pairing code"
              className="mt-3 w-full rounded-lg border border-white/10 bg-black px-4 py-3 text-center text-2xl tracking-[0.35em] outline-none focus:border-white/30"
            />
            <button type="submit" disabled={codeInput.length !== 6} className="mt-3 w-full rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-30">Connect display</button>
          </form>

          <section className="space-y-2">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-widest text-neutral-500">Displays</h2>
            {displays.map((display, index) => (
              <div key={display.id} className={`rounded-xl border p-3 ${display.id === activeId ? "border-white/30 bg-white/[0.07]" : "border-white/10 bg-white/[0.02]"}`}>
                <button type="button" onClick={() => setActiveId(display.id)} className="flex w-full items-center gap-3 text-left">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${display.status === "connected" ? "bg-green-400" : display.status === "error" ? "bg-red-400" : "bg-amber-400"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">Display {index + 1}</span>
                    <span className="mt-0.5 block text-xs text-neutral-500">Code {display.code} · {display.status}</span>
                  </span>
                  <span className="text-neutral-600">{display.id === activeId ? "●" : "○"}</span>
                </button>
                <button type="button" onClick={() => removeDisplay(display.id)} className="mt-2 w-full rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-400 hover:bg-white/[0.05] hover:text-white">Disconnect display</button>
              </div>
            ))}
            {displays.length === 0 ? <p className="rounded-xl border border-dashed border-white/10 p-4 text-sm text-neutral-600">No displays connected yet.</p> : null}
          </section>
        </aside>

        <section className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
          {activeDisplay ? (
            <>
              <div className="border-b border-white/10 px-4 py-3">
                <div className="text-sm font-semibold">Display configuration</div>
                <div className="mt-1 text-xs text-neutral-500">Code {activeDisplay.code} · This display's settings are independent.</div>
              </div>
              {displays.map((display) => (
                <div key={display.id} hidden={display.id !== activeId}>
                  <RemoteSession
                    role="controller"
                    events={[]}
                    code={display.code}
                    hidden={display.id !== activeId}
                    onStatus={(status) => updateStatus(display.id, status)}
                  />
                </div>
              ))}
            </>
          ) : (
            <div className="flex min-h-80 flex-col items-center justify-center p-8 text-center">
              <h2 className="text-base font-semibold">Choose a display to configure</h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-neutral-500">Each display keeps its own layout, event selection, and surface settings. Switching tabs does not disconnect the other displays.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
