"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { TBAEvent } from "@/lib/tba/types";

import {
  LAYOUTS,
  pickHighlightLayout,
  pickLayout,
} from "@/lib/multiview/layouts";

import type {
  TileSurfaceActions,
  TileSurfaceController,
} from "./TileSurfaceActions";
import {
  createInitialTileSurfaceState,
  type UpcomingMatchAlert,
  type TileSurfaceState,
} from "./TileSurfaceState";
import { createEventViewConfig } from "@/components/eventview/EventViewConfig";

const CONTROLS_HIDE_DELAY = 3000;

export type UseTileSurfaceControllerOptions = {
  events: string[];
  controller?: TileSurfaceController;
};

export function useTileSurfaceController({
  events,
  controller: externalController,
}: UseTileSurfaceControllerOptions): TileSurfaceController {
  const initialStreams = useMemo(
    () => [...new Set(events.filter(Boolean).map(String))],
    [events]
  );

  const [state, setState] = useState<TileSurfaceState>(() =>
    createInitialTileSurfaceState(initialStreams)
  );
  const listenersRef = useRef(
    new Set<(state: TileSurfaceState) => void>()
  );

  const stateRef = useRef(state);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeMatchHighlightsRef = useRef(new Map<string, string>());
  const matchHighlightSnapshotRef = useRef<{
    activeKey: string | null;
    highlightLayoutKey: TileSurfaceState["highlightLayoutKey"];
  } | null>(null);
  const lastAutoHighlightEventRef = useRef<string | null>(null);

  useEffect(() => {
    stateRef.current = state;
    for (const listener of listenersRef.current) {
      listener(state);
    }
  }, [state]);

  const update = useCallback(
    (updater: (current: TileSurfaceState) => TileSurfaceState) => {
      setState((current) => updater(current));
    },
    []
  );

  const replaceState = useCallback((nextState: TileSurfaceState) => {
    setState(nextState);
  }, []);

  const clearControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
  }, []);

  const showControls = useCallback(() => {
    update((current) => ({
      ...current,
      controlsVisible: true,
    }));

    clearControlsTimeout();

    if (stateRef.current.eventPickerOpen) {
      return;
    }

    controlsTimeoutRef.current = setTimeout(() => {
      update((current) => ({
        ...current,
        controlsVisible: false,
      }));
      controlsTimeoutRef.current = null;
    }, CONTROLS_HIDE_DELAY);
  }, [clearControlsTimeout, update]);

  const hideControls = useCallback(() => {
    clearControlsTimeout();

    update((current) => ({
      ...current,
      controlsVisible: false,
    }));
  }, [clearControlsTimeout, update]);

  useEffect(() => {
    showControls();

    return clearControlsTimeout;
  }, [clearControlsTimeout, showControls]);

  useEffect(() => {
    if (state.eventPickerOpen) {
      clearControlsTimeout();
      update((current) => ({
        ...current,
        controlsVisible: true,
      }));
      return;
    }

    showControls();
  }, [
    clearControlsTimeout,
    showControls,
    state.eventPickerOpen,
    update,
  ]);

  useEffect(() => {
    const handlePopState = () => {
      const url = new URL(window.location.href);
      const eventKeys = [...new Set(url.searchParams.getAll("event").filter(Boolean))];
      const tileEvents = Object.fromEntries(
        eventKeys.map((eventKey) => [eventKey, eventKey] as const),
      );
      const tileTypes = Object.fromEntries(
        eventKeys.map((eventKey) => [eventKey, "eventView"] as const),
      );
      const tileIds = eventKeys;

      update((current) => ({
        ...current,
        streams: tileIds,
        priority: tileIds,
        tileEvents,
        tileTypes,
        eventConfigs: Object.fromEntries(
          eventKeys.map((eventKey) => [
            eventKey,
            current.eventConfigs[eventKey] ?? createEventViewConfig(),
          ])
        ),
        activeKey: null,
        highlightLayoutKey: null,
      }));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [update]);

  useEffect(() => {
    if (!state.eventPickerOpen) {
      return;
    }

    let cancelled = false;

    async function loadEvents() {
      update((current) => ({
        ...current,
        eventsLoading: true,
      }));

      try {
        const response = await fetch("/api/events/active", {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(
            `Failed to load events: ${response.status}`
          );
        }

        const data = (await response.json()) as TBAEvent[];

        if (!cancelled) {
          update((current) => ({
            ...current,
            availableEvents: data,
            eventsLoading: false,
          }));
        }
      } catch (error) {
        console.error("Failed to load active events:", error);

        if (!cancelled) {
          update((current) => ({
            ...current,
            availableEvents: [],
            eventsLoading: false,
          }));
        }
      }
    }

    loadEvents();

    return () => {
      cancelled = true;
    };
  }, [state.eventPickerOpen, update]);

  const updateUrl = useCallback((tileIds: string[], tileEvents: Record<string, string>) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("event");

    for (const tileId of tileIds) {
      const eventKey = tileEvents[tileId];
      if (!eventKey) continue;
      url.searchParams.append("event", eventKey);
    }

    window.history.pushState({}, "", url);
  }, []);

  const toggleActive = useCallback(
    (eventKey: string) => {
      showControls();

      update((current) => {
        if (current.activeKey === eventKey) {
          return {
            ...current,
            activeKey: null,
            highlightLayoutKey: null,
          };
        }

        const layoutKey =
          current.layoutKey ??
          pickLayout(current.streams.length || 1);

        return {
          ...current,
          activeKey: eventKey,
          highlightLayoutKey: pickHighlightLayout(
            LAYOUTS[layoutKey]?.slots.length ?? 1
          ),
        };
      });
    },
    [showControls, update]
  );

  const setUpcomingMatchAlert = useCallback(
    (signal: UpcomingMatchAlert) => {
      if (!stateRef.current.streams.includes(signal.eventKey)) {
        return;
      }

      update((current) => {
        if (signal.type === "upcoming_match_cleared") {
          if (current.upcomingMatchKeys[signal.eventKey] !== signal.matchKey) {
            return current;
          }

          const upcomingMatchKeys = { ...current.upcomingMatchKeys };
          delete upcomingMatchKeys[signal.eventKey];

          return {
            ...current,
            upcomingMatchKeys,
          };
        }

        return current.upcomingMatchKeys[signal.eventKey] === signal.matchKey
          ? current
          : {
              ...current,
              upcomingMatchKeys: {
                ...current.upcomingMatchKeys,
                [signal.eventKey]: signal.matchKey,
              },
            };
      });
    },
    [update],
  );

  const highlightEvent = useCallback(
    (eventKey: string) => {
      showControls();

      update((current) => {
        if (!current.streams.includes(eventKey)) {
          return current;
        }

        const layoutKey =
          current.layoutKey ??
          pickLayout(current.streams.length || 1);

        if (
          current.activeKey === eventKey &&
          current.highlightLayoutKey !== null
        ) {
          return current;
        }

        return {
          ...current,
          activeKey: eventKey,
          highlightLayoutKey: pickHighlightLayout(
            LAYOUTS[layoutKey]?.slots.length ?? 1,
          ),
        };
      });
    },
    [showControls, update],
  );

  const highlightMatch = useCallback(
    (eventKey: string, matchKey: string) => {
      const current = stateRef.current;
      if (!current.streams.includes(eventKey)) return;

      if (activeMatchHighlightsRef.current.size === 0) {
        matchHighlightSnapshotRef.current = {
          activeKey: current.activeKey,
          highlightLayoutKey: current.highlightLayoutKey,
        };
      }

      activeMatchHighlightsRef.current.set(eventKey, matchKey);

      // Priority is the arbitration order: the first event with an active
      // imminent match wins, regardless of which event reported it last.
      const winner = current.priority.find((key) =>
        activeMatchHighlightsRef.current.has(key) && current.streams.includes(key)
      );
      if (!winner) return;

      if (
        lastAutoHighlightEventRef.current === winner &&
        current.activeKey === winner
      ) {
        return;
      }

      lastAutoHighlightEventRef.current = winner;
      highlightEvent(winner);
    },
    [highlightEvent],
  );

  const releaseMatchHighlight = useCallback(
    (eventKey: string, matchKey: string) => {
      // A newer imminent match for this same event supersedes the old key.
      if (activeMatchHighlightsRef.current.get(eventKey) !== matchKey) return;
      activeMatchHighlightsRef.current.delete(eventKey);

      const current = stateRef.current;
      const winner = current.priority.find((key) =>
        activeMatchHighlightsRef.current.has(key) && current.streams.includes(key)
      );

      if (winner) {
        lastAutoHighlightEventRef.current = winner;
        if (current.activeKey !== winner || current.highlightLayoutKey === null) {
          highlightEvent(winner);
        }
        return;
      }

      const previousWinner = lastAutoHighlightEventRef.current;
      const snapshot = matchHighlightSnapshotRef.current;
      lastAutoHighlightEventRef.current = null;
      matchHighlightSnapshotRef.current = null;

      if (!snapshot) return;

      update((latest) => {
        // Don't override a manual selection made while the automatic
        // highlight was active.
        if (
          latest.activeKey !== previousWinner ||
          latest.highlightLayoutKey === null
        ) {
          return latest;
        }

        return {
          ...latest,
          activeKey: snapshot.activeKey,
          highlightLayoutKey: snapshot.highlightLayoutKey,
        };
      });
    },
    [highlightEvent, update],
  );

  const actions = useMemo<TileSurfaceActions>(
    () => ({
      showControls,
      hideControls,

      setUpcomingMatchAlert,
      highlightEvent,
      highlightMatch,
      releaseMatchHighlight,

      toggleActive,

      clearActive: () => {
        update((current) => ({
          ...current,
          activeKey: null,
          highlightLayoutKey: null,
        }));
      },

      setLayout: (layoutKey) => {
        showControls();
        update((current) => ({
          ...current,
          layoutKey,
          highlightLayoutKey: null,
        }));
      },

      resetLayout: () => {
        showControls();
        update((current) => ({
          ...current,
          layoutKey: null,
          highlightLayoutKey: null,
        }));
      },

      movePriority: (position, direction) => {
        showControls();
        update((current) => {
          const target = position + direction;

          if (
            target < 0 ||
            target >= current.priority.length
          ) {
            return current;
          }

          const next = [...current.priority];
          [next[position], next[target]] = [
            next[target],
            next[position],
          ];

          return {
            ...current,
            priority: next,
          };
        });
      },

      selectPriorityEdit: (eventKey) => {
        update((current) => ({
          ...current,
          priorityEditKey: eventKey,
        }));
      },

      movePriorityEdit: (direction) => {
        const key = stateRef.current.priorityEditKey;

        if (!key) {
          return;
        }

        update((current) => {
          const position = current.priority.indexOf(key);

          if (position === -1) {
            return current;
          }

          const target = position + direction;

          if (
            target < 0 ||
            target >= current.priority.length
          ) {
            return current;
          }

          const next = [...current.priority];
          [next[position], next[target]] = [
            next[target],
            next[position],
          ];

          return {
            ...current,
            priority: next,
          };
        });
      },

      openEventPicker: () => {
        showControls();
        update((current) => ({
          ...current,
          eventSearch: "",
          eventPickerOpen: true,
        }));
      },

      closeEventPicker: () => {
        showControls();
        update((current) => ({
          ...current,
          eventPickerOpen: false,
        }));
      },

      setEventSearch: (search) => {
        update((current) => ({
          ...current,
          eventSearch: search,
        }));
      },

      addEvent: (event) => {
        const eventKey = String(event.key);
        const current = stateRef.current;

        if (current.streams.some((tileId) => current.tileEvents[tileId] === eventKey)) {
          return;
        }

        const nextStreams = [...current.streams, eventKey];
        const nextTileEvents = { ...current.tileEvents, [eventKey]: eventKey };
        const nextTileTypes = { ...current.tileTypes, [eventKey]: "eventView" as const };

        update((next) => ({
          ...next,
          streams: nextStreams,
          priority: [...next.priority, eventKey],
          tileEvents: nextTileEvents,
          tileTypes: nextTileTypes,
          eventConfigs: {
            ...next.eventConfigs,
            [eventKey]: next.eventConfigs[eventKey] ?? createEventViewConfig(),
          },
        }));

        updateUrl(nextStreams, nextTileEvents);
        showControls();
      },

      removeEvent: (tileId) => {
        const current = stateRef.current;
        const nextStreams = current.streams.filter((key) => key !== tileId);
        const nextTileEvents = { ...current.tileEvents };
        const nextTileTypes = { ...current.tileTypes };
        delete nextTileEvents[tileId];
        delete nextTileTypes[tileId];
        const removedEventKey = current.tileEvents[tileId];
        const stillHasEventView = nextStreams.some((key) => nextTileTypes[key] === "eventView" && nextTileEvents[key] === removedEventKey);
        update((next) => ({
          ...next,
          streams: nextStreams,
          priority: next.priority.filter((key) => key !== tileId),
          activeKey: next.activeKey === tileId ? null : next.activeKey,
          highlightLayoutKey: next.activeKey === tileId ? null : next.highlightLayoutKey,
          priorityEditKey: next.priorityEditKey === tileId ? null : next.priorityEditKey,
          tileEvents: nextTileEvents,
          tileTypes: nextTileTypes,
          eventConfigs: !stillHasEventView && nextTileTypes[removedEventKey ?? ""] !== "eventView"
            ? Object.fromEntries(Object.entries(next.eventConfigs).filter(([key]) => key !== removedEventKey))
            : next.eventConfigs,
          labels: Object.fromEntries(Object.entries(next.labels).filter(([key]) => key !== tileId)),
        }));
        updateUrl(nextStreams, nextTileEvents);
        showControls();
      },

      setEventViewConfig: (eventKey, config) => {
        update((current) => {
          const existing = current.eventConfigs[eventKey];
          if (!existing) return current;

          return {
            ...current,
            eventConfigs: {
              ...current.eventConfigs,
              [eventKey]: {
                ...existing,
                ...config,
                trackedTeams: config.trackedTeams
                  ? [...config.trackedTeams]
                  : existing.trackedTeams,
                presentation: {
                  ...existing.presentation,
                  ...config.presentation,
                },
              },
            },
          };
        });
      },

      setEventViewTrackedTeams: (eventKey, teams) => {
        update((current) => {
          const existing = current.eventConfigs[eventKey];
          if (!existing) return current;

          return {
            ...current,
            eventConfigs: {
              ...current.eventConfigs,
              [eventKey]: {
                ...existing,
                trackedTeams: [...teams],
              },
            },
          };
        });
      },

      setEventViewStream: (eventKey, streamKey) => {
        update((current) => {
          const existing = current.eventConfigs[eventKey];
          if (!existing) return current;

          return {
            ...current,
            eventConfigs: {
              ...current.eventConfigs,
              [eventKey]: {
                ...existing,
                selectedStream: streamKey,
              },
            },
          };
        });
      },


      runEventViewCommand: (eventKey, type) => {
        update((current) => {
          const existing = current.eventConfigs[eventKey];
          if (!existing) return current;

          return {
            ...current,
            eventConfigs: {
              ...current.eventConfigs,
              [eventKey]: {
                ...existing,
                command: {
                  id: Date.now(),
                  type,
                },
              },
            },
          };
        });
      },

      clearEventViewCommand: (eventKey) => {
        update((current) => {
          const existing = current.eventConfigs[eventKey];
          if (!existing || !existing.command) return current;

          return {
            ...current,
            eventConfigs: {
              ...current.eventConfigs,
              [eventKey]: {
                ...existing,
                command: null,
              },
            },
          };
        });
      },

      setEventViewPresentation: (eventKey, presentation) => {
        update((current) => {
          const existing = current.eventConfigs[eventKey];
          if (!existing) return current;

          return {
            ...current,
            eventConfigs: {
              ...current.eventConfigs,
              [eventKey]: {
                ...existing,
                presentation: {
                  ...existing.presentation,
                  ...presentation,
                },
              },
            },
          };
        });
      },

      registerLabel: (eventKey, label) => {
        update((current) => {
          if (current.labels[eventKey] === label) {
            return current;
          }

          return {
            ...current,
            labels: {
              ...current.labels,
              [eventKey]: label,
            },
          };
        });
      },
    }),
    [
      setUpcomingMatchAlert,
      highlightEvent,
      highlightMatch,
      releaseMatchHighlight,
      hideControls,
      showControls,
      toggleActive,
      update,
      updateUrl,
    ]
  );

  useEffect(() => {
    update((current) => {
      const valid = new Set(current.streams);
      const labels = Object.fromEntries(
        Object.entries(current.labels).filter(([key]) =>
          valid.has(key)
        )
      );

      return Object.keys(labels).length ===
        Object.keys(current.labels).length
        ? current
        : {
            ...current,
            labels,
          };
    });
  }, [state.streams, update]);

  const localController = useMemo<TileSurfaceController>(
    () => ({
      getState: () => stateRef.current,
      replaceState,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
      actions,
    }),
[actions, replaceState]
  );

  return externalController ?? localController;
}

export function useTileSurfaceKeyboard(
  state: TileSurfaceState,
  actions: TileSurfaceActions,
  onSettings?: () => void,
) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;

      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLButtonElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      actions.showControls();

      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSettings?.();
        return;
      }

      if (event.key >= "1" && event.key <= "9") {
        event.preventDefault();

        const index = Number(event.key) - 1;
        const eventKey = state.streams[index];

        if (!eventKey) {
          return;
        }

        if (event.ctrlKey) {
          actions.selectPriorityEdit(
            state.priorityEditKey === eventKey ? null : eventKey
          );
          return;
        }

        actions.toggleActive(eventKey);
        return;
      }

      if (event.key === "0") {
        actions.clearActive();
        return;
      }

      if (event.key === "-" || event.key === "=") {
        const layoutKeys = Object.keys(LAYOUTS) as Array<
          keyof typeof LAYOUTS
        >;
        const currentKey =
          state.layoutKey ??
          pickLayout(state.streams.length || 1);
        const currentIndex = layoutKeys.indexOf(currentKey);
        const direction = event.key === "-" ? -1 : 1;
        const nextIndex = currentIndex + direction;

        if (
          nextIndex >= 0 &&
          nextIndex < layoutKeys.length
        ) {
          actions.setLayout(layoutKeys[nextIndex]);
        }

        return;
      }

      if (event.key === "ArrowUp" && state.priorityEditKey) {
        actions.movePriorityEdit(-1);
        return;
      }

      if (event.key === "ArrowDown" && state.priorityEditKey) {
        actions.movePriorityEdit(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [actions, onSettings, state]);
}
