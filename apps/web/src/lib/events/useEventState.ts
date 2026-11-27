"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { CanonicalEventSnapshotData, EventWebSocketStatus } from "./workerRealtime";
import {
  getCanonicalEventSnapshot,
  subscribeCanonicalEventSnapshot,
  getCanonicalEventAnalytics,
  subscribeCanonicalEventAnalytics,
  getCanonicalRuntimeStatus,
  subscribeCanonicalRuntimeStatus,
} from "./sharedWorkerClient";

/** Subscribe to the canonical EventRuntime snapshot stream. */
export function useCanonicalEventSnapshot(eventKey: string): {
  version: number;
  snapshot: CanonicalEventSnapshotData;
} | undefined {
  const subscribe = useCallback(
    (listener: () => void) => eventKey
      ? subscribeCanonicalEventSnapshot(eventKey, listener)
      : () => {},
    [eventKey],
  );
  const getSnapshot = useCallback(
    () => eventKey ? getCanonicalEventSnapshot(eventKey) : undefined,
    [eventKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/** Subscribe to durable EventRuntime analytics publications. */
export function useCanonicalEventAnalytics(eventKey: string) {
  const subscribe = useCallback(
    (listener: () => void) => eventKey
      ? subscribeCanonicalEventAnalytics(eventKey, listener)
      : () => {},
    [eventKey],
  );
  const getSnapshot = useCallback(
    () => eventKey ? getCanonicalEventAnalytics(eventKey) : undefined,
    [eventKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/** Connection health for the canonical EventRuntime stream. */
export function useCanonicalRuntimeStatus(eventKey: string): EventWebSocketStatus {
  const subscribe = useCallback((listener: () => void) => {
    if (!eventKey) return () => {};
    const unsubscribeSnapshot = subscribeCanonicalEventSnapshot(eventKey, () => {});
    const unsubscribeStatus = subscribeCanonicalRuntimeStatus(listener);
    return () => { unsubscribeSnapshot(); unsubscribeStatus(); };
  }, [eventKey]);
  const getSnapshot = useCallback(
    () => getCanonicalRuntimeStatus(),
    [],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
