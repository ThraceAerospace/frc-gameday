"use client";

import { createContext, type ReactNode } from "react";
import type { CanonicalEventSnapshotData } from "./workerRealtime";

export type CanonicalEventSnapshotValue = {
  version: number;
  snapshot: CanonicalEventSnapshotData;
};

export const CanonicalEventSnapshotsContext = createContext<Record<string, CanonicalEventSnapshotValue> | null>(null);

export function CanonicalEventSnapshotsProvider({
  snapshots,
  children,
}: {
  snapshots: Record<string, CanonicalEventSnapshotValue>;
  children: ReactNode;
}) {
  return (
    <CanonicalEventSnapshotsContext.Provider value={snapshots}>
      {children}
    </CanonicalEventSnapshotsContext.Provider>
  );
}
