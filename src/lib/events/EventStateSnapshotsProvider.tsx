"use client";

import { createContext, type ReactNode } from "react";
import type { EventStateSnapshot } from "./EventState";

export const EventStateSnapshotsContext = createContext<Record<string, EventStateSnapshot> | null>(null);

export function EventStateSnapshotsProvider({
  snapshots,
  children,
}: {
  snapshots: Record<string, EventStateSnapshot>;
  children: ReactNode;
}) {
  return (
    <EventStateSnapshotsContext.Provider value={snapshots}>
      {children}
    </EventStateSnapshotsContext.Provider>
  );
}
