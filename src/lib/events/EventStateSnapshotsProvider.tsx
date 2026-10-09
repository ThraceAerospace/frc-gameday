"use client";

import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import {
  EventState,
  type EventStateSnapshot,
} from "./EventState";

const eventStates = new Map<string, EventState>();
const EventStateSnapshotsContext = createContext<Record<string, EventStateSnapshot> | null>(null);

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
  // A remote display is a read-only renderer: do not instantiate EventState
  // there, because that would start a second set of TBA subscriptions/polls.
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

  const localSnapshot = useSyncExternalStore(
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
    ...localSnapshot,
  };
}
