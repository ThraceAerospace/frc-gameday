"use client";

import { startCastSession } from "@/lib/cast/castClient";

export default function CastButton() {
  const handleCast = async () => {
    const chrome = (window as any).chrome;
    try {
      if (!chrome?.cast) {
        alert("Cast not available in this browser (use Chrome)");
        return;
      }

      await startCastSession();
    } catch (err) {
      console.error("Cast failed:", err);
    }
  };

  return (
    <button
      onClick={handleCast}
      className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-sm"
    >
      Cast
    </button>
  );
}