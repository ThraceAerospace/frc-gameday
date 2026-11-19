"use client";

import { createContext, type ReactNode } from "react";
import type { FieldViewEventSnapshot } from "@fieldview/domain";

export type CanonicalEventSnapshotValue = {
  version: number;
  snapshot: FieldViewEventSnapshot;
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
