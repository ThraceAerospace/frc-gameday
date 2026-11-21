"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-request a server-rendered page while its durable runtime snapshot is
 * pending. The server request only queues acquisition; it never waits for
 * provider work. Unmounts automatically stop the refresh loop.
 */
export default function PendingSnapshotRefresh({ intervalMs = 5_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, router]);

  return (
    <span className="sr-only" role="status" aria-live="polite">
      Data is loading. This page will refresh automatically.
    </span>
  );
}
