"use client";

import {
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import type { EventStateSnapshot } from "./EventState";
import { EventStateSnapshotsContext } from "./EventStateSnapshotsProvider";
import {
  getEventStateController,
  getEventStateSnapshot,
  subscribeSharedEventState,
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
