"use client";

import { useEffect, type ReactNode } from "react";
import { registerSharedLiveRuntime } from "./sharedWorkerClient";

/**
 * Route-level lease: a live route keeps the shared worker and its one
 * WebSocket alive even before a component requests a particular event.
 */
export function SharedLiveRuntimeProvider({ children }: { children: ReactNode }) {
  useEffect(() => registerSharedLiveRuntime(), []);
  return children;
}
