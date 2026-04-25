"use client";

import { useEffect } from "react";

export default function StreamModal({
  open,
  setOpen,
  streams,
  activeKey,
  setActiveKey,
}) {
  // ESC to close
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
      {/* modal container */}
      <div className="w-[420px] max-w-[90vw] bg-neutral-900 rounded-lg shadow-xl">
        
        {/* header */}
        <div className="flex justify-between items-center px-4 py-3 border-b border-neutral-700">
          <h2 className="text-white font-medium">Select Stream</h2>

          <button
            onClick={() => setOpen(false)}
            className="text-gray-400 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* list */}
        <div className="max-h-[60vh] overflow-y-auto">
          {streams.map((s) => {
            const isActive = s.key === activeKey;

            return (
              <button
                key={s.key}
                onClick={() => {
                  setActiveKey(s.key);
                  setOpen(false);
                }}
                className={`w-full text-left px-4 py-3 flex justify-between items-center hover:bg-neutral-800 ${
                  isActive ? "bg-neutral-800" : ""
                }`}
              >
                <div>
                  <div className="text-white text-sm">
                    {s.type === "youtube" ? s.meta?.title || "YouTube Stream" : "Twitch Stream"}
                  </div>
                  <div className="text-xs text-gray-400">
                    {s.channel}
                  </div>
                </div>

                {/* active indicator */}
                {isActive && (
                  <div className="text-xs text-green-400 text-nowrap">
                    ● LIVE
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* footer */}
        <div className="px-4 py-2 border-t border-neutral-700 text-xs text-gray-500">
          {streams.length} stream{streams.length !== 1 ? "s" : ""} available
        </div>
      </div>
    </div>
  );
}