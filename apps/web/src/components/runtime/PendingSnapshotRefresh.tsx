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
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > 24) {
        window.clearInterval(timer);
        return;
      }
      router.refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, router]);

  return (
    <div className="my-4 flex items-center gap-3 rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-card)] px-4 py-3 text-sm text-[var(--fv-muted)]" role="status" aria-live="polite">
      <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-[var(--fv-brand)]" aria-hidden="true" />
      <span>Loading canonical data. This section will update automatically.</span>
    </div>
  );
}
