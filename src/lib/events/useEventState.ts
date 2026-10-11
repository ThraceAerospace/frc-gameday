"use client";

import {
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import {
  EventState,
  type EventStateSnapshot,
} from "./EventState";
import { EventStateSnapshotsContext } from "./EventStateSnapshotsProvider";

const eventStates = new Map<string, EventState>();

function getEventState(eventKey: string) {
  let state = eventStates.get(eventKey);

  if (!state) {
    state = new EventState(eventKey);
    eventStates.set(eventKey, state);
  }

  return state;
}

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

export function subscribeEventState(
  eventKey: string,
  listener: (snapshot: EventStateSnapshot) => void,
) {
  const state = getEventState(eventKey);
  const unsubscribe = state.subscribe(listener);

  listener(state.getSnapshot());

  return unsubscribe;
}

export function useEventState(eventKey: string) {
  const remoteSnapshots = useContext(EventStateSnapshotsContext);
  // Remote displays consume controller-published snapshots and must not start
  // their own TBA polling or WebSocket subscriptions.
  const state = remoteSnapshots === null && eventKey
    ? getEventState(eventKey)
    : null;

  const subscribe = useCallback(
    (listener: () => void) =>
      state
        ? state.subscribe(listener)
        : () => {},
    [state],
  );

  const getSnapshot = useCallback(
    () =>
      state
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
