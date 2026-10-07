"use client";

import {
  useEffect,
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

export function useEventState(eventKey: string) {
  const state = eventKey
    ? getEventState(eventKey)
    : null;

  const snapshot = useSyncExternalStore(
    (listener) =>
      state
        ? state.subscribe(listener)
        : () => {},
    () =>
      state
        ? state.getSnapshot()
        : EMPTY_SNAPSHOT,
    () => EMPTY_SNAPSHOT,
  );

  useEffect(() => {
    if (!state) {
      return;
    }

    return () => {
      state.stop();
    };
  }, [state]);

  return {
    state,
    ...snapshot,
  };
}
