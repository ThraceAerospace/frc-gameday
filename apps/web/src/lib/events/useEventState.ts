"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import type { EventStateSnapshot } from "./EventState";
import type { FieldViewEventSnapshot } from "@fieldview/domain";
import type { EventWebSocketStatus } from "@/lib/realtime/client";
import { EventStateSnapshotsContext } from "./EventStateSnapshotsProvider";
import { CanonicalEventSnapshotsContext } from "./CanonicalEventSnapshotsProvider";
import {
  getEventStateController,
  getEventStateSnapshot,
  subscribeSharedEventState,
  getCanonicalEventSnapshot,
  subscribeCanonicalEventSnapshot,
  getCanonicalEventAnalytics,
  subscribeCanonicalEventAnalytics,
  refreshCanonicalEventAnalytics,
  getCanonicalRuntimeStatus,
  subscribeCanonicalRuntimeStatus,
} from "./sharedWorkerClient";

const EMPTY_SNAPSHOT: EventStateSnapshot = {
  event: null,
  teams: [],
  matches: [],
  eventNextMatch: null,
  eventLastMatch: null,
  teamsStatuses: {},
  alliances: [],
  oprs: null,
  loading: false,
  error: null,
  websocketStatus: "disconnected",
  websocketStale: false,
  upcomingMatchKey: null,
  upcomingMatchTeamKeys: [],
  statboticsMatches: {},
};

/**
 * Subscribe to the shared event lifecycle. The SharedWorker is the only owner
 * of EventState acquisition; each tab receives snapshots through its own port.
 */
export function subscribeEventState(
  eventKey: string,
  listener: (snapshot: EventStateSnapshot) => void,
) {
  return subscribeSharedEventState(eventKey, () => {
    listener(getEventStateSnapshot(eventKey) ?? EMPTY_SNAPSHOT);
  });
}

export function useEventState(eventKey: string) {
  const remoteSnapshots = useContext(EventStateSnapshotsContext);
  // Remote displays consume controller-published snapshots and must not create
  // a SharedWorker subscription or acquire their own event data.
  const state = remoteSnapshots === null && eventKey
    ? getEventStateController(eventKey)
    : null;

  const subscribe = useCallback(
    (listener: () => void) =>
      state
        ? subscribeSharedEventState(eventKey, listener)
        : () => {},
    [eventKey, state],
  );

  const getSnapshot = useCallback(
    () => state
      ? state.getSnapshot()
      : EMPTY_SNAPSHOT,
    [state],
  );

  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_SNAPSHOT,
  );

  if (remoteSnapshots !== null) {
    return {
      state: null,
      ...(eventKey ? remoteSnapshots[eventKey] ?? EMPTY_SNAPSHOT : EMPTY_SNAPSHOT),
    };
  }

  return {
    state,
    ...snapshot,
  };
}

/**
 * Read the canonical domain snapshot distributed by the Cloudflare runtime.
 * The SharedWorker owns the upstream WebSocket and snapshot recovery; this
 * hook only subscribes to its per-tab canonical snapshot notifications.
 */
export function useCanonicalEventSnapshot(eventKey: string): {
  version: number;
  snapshot: FieldViewEventSnapshot;
} | undefined {
  const remoteSnapshots = useContext(CanonicalEventSnapshotsContext);
  const enabled = remoteSnapshots === null && Boolean(eventKey);
  const subscribe = useCallback(
    (listener: () => void) => enabled
      ? subscribeCanonicalEventSnapshot(eventKey, listener)
      : () => {},
    [enabled, eventKey],
  );
  const getSnapshot = useCallback(
    () => enabled ? getCanonicalEventSnapshot(eventKey) : undefined,
    [enabled, eventKey],
  );
  const liveSnapshot = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  return remoteSnapshots === null ? liveSnapshot : remoteSnapshots[eventKey];
}


/** Subscribe to durable EventRuntime analytics publications via the shared Worker. */
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
  const publication = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  useEffect(() => {
    if (eventKey) refreshCanonicalEventAnalytics(eventKey);
  }, [eventKey]);
  return publication;
}

/** Connection health for the shared canonical EventRuntime snapshot stream. */
export function useCanonicalRuntimeStatus(eventKey: string): EventWebSocketStatus {
  const remoteSnapshots = useContext(CanonicalEventSnapshotsContext);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (remoteSnapshots !== null) return () => {};
      // A status subscription must also establish the event's canonical
      // runtime stream; otherwise no shared WebSocket exists to report status.
      const unsubscribeSnapshot = subscribeCanonicalEventSnapshot(eventKey, () => {});
      const unsubscribeStatus = subscribeCanonicalRuntimeStatus(listener);
      return () => {
        unsubscribeSnapshot();
        unsubscribeStatus();
      };
    },
    [eventKey, remoteSnapshots],
  );
  const getSnapshot = useCallback(
    () => remoteSnapshots === null
      ? getCanonicalRuntimeStatus()
      : remoteSnapshots[eventKey] ? "connected" : "disconnected",
    [eventKey, remoteSnapshots],
  );
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => remoteSnapshots?.[eventKey] ? "connected" : "disconnected",
  );
}
