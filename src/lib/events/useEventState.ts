"use client";

import {
  useCallback,
  useSyncExternalStore,
} from "react";
import {
  EventState,
  type EventStateSnapshot,
} from "./EventState";

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
  loading: false,
  error: null,
  websocketStatus: "disconnected",
  websocketStale: false,
};

export type EventRealtimeStatus = Pick<
  EventStateSnapshot,
  "websocketStatus" | "websocketStale"
>;

export function subscribeEventRealtimeStatus(
  eventKey: string,
  listener: (status: EventRealtimeStatus) => void,
) {
  const state = getEventState(eventKey);
  const emitStatus = (snapshot: EventStateSnapshot) =>
    listener({
      websocketStatus: snapshot.websocketStatus,
      websocketStale: snapshot.websocketStale,
    });
  const unsubscribe = state.subscribe(emitStatus);

  emitStatus(state.getSnapshot());

  return unsubscribe;
}

export function useEventState(eventKey: string) {
  const state = eventKey
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

  return {
    state,
    ...snapshot,
  };
}
