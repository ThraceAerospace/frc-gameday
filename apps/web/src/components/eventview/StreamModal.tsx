"use client";

import { useEffect, useState } from "react";

type Stream = { key: string; type: string; date?: string | null; meta?: { title?: string | null } | null };
type Props = { open: boolean; onClose: () => void; streams?: Stream[]; activeKey?: string | null; onSelect: (key: string) => void };

export default function StreamModal({ open, onClose, streams = [], activeKey, onSelect }: Props) {
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState("");

  useEffect(() => {
    if (!open) {
      setUrl("");
      setUrlError("");
      return;
    }
    const close = (e: globalThis.KeyboardEvent) => e.key === "Escape" && (e.stopImmediatePropagation(), onClose());
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);

  if (!open) return null;

  const addCustomStream = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = url.trim();
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        setUrlError("Enter a valid HTTP or HTTPS stream URL.");
        return;
      }
      onSelect(`custom:${parsed.toString()}`);
      onClose();
    } catch {
      setUrlError("Enter a complete URL, including https://.");
    }
  };

  return <div data-modal-layer className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal-panel" onMouseDown={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div><div className="font-semibold">Webcasts</div><div className="text-xs text-neutral-500">{streams.length} available</div></div>
        <button onClick={onClose} className="text-neutral-500 hover:text-white">Close</button>
      </div>
      <div className="max-h-[65vh] overflow-y-auto p-2">
        {streams.length ? streams.map((stream) => <button key={stream.key} onClick={() => { onSelect(stream.key); onClose(); }} className={`w-full rounded-lg p-3 text-left ${stream.key === activeKey ? "bg-white text-black" : "hover:bg-white/5"}`}>
          <div className="text-sm font-medium">{stream.meta?.title || `${stream.type === "youtube" ? "YouTube" : "Twitch"} webcast`}</div>
          <div className="mt-1 text-xs opacity-60">{stream.date || "Date not specified"}</div>
        </button>) : <div className="p-6 text-center text-sm text-neutral-500">No supported webcasts have been published.</div>}
      </div>
      <form onSubmit={addCustomStream} className="border-t border-white/10 p-4">
        <label htmlFor="custom-webcast-url" className="mb-2 block text-sm font-medium">Open a stream by URL</label>
        <div className="flex gap-2">
          <input id="custom-webcast-url" type="url" inputMode="url" autoComplete="url" value={url} onChange={(event) => { setUrl(event.target.value); setUrlError(""); }} placeholder="https://…" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-white/30" aria-describedby={urlError ? "custom-webcast-error" : "custom-webcast-help"} />
          <button type="submit" className="shrink-0 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-black hover:bg-neutral-200">Open</button>
        </div>
        {urlError ? <p id="custom-webcast-error" role="alert" className="mt-2 text-xs text-red-400">{urlError}</p> : <p id="custom-webcast-help" className="mt-2 text-xs text-neutral-500">For streams not listed by TBA. The URL is only kept in this active session.</p>}
      </form>
    </div>
  </div>;
}
