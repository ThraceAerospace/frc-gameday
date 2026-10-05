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
  MultiviewActions,
  MultiviewController,
  MultiviewWebSocketEvent,
  MultiviewWebSocketHandlers,
} from "./MultiviewActions";
import {
  createInitialMultiviewState,
  type MatchImminentSignal,
  type MultiviewState,
} from "./MultiviewState";
import { createEventViewConfig } from "@/components/eventview/EventViewConfig";

const CONTROLS_HIDE_DELAY = 3000;

export type UseMultiviewControllerOptions = {
  events: string[];
  controller?: MultiviewController;
};

export function useMultiviewController({
  events,
  controller: externalController,
}: UseMultiviewControllerOptions): MultiviewController {
  const initialStreams = useMemo(
    () => [...new Set(events.filter(Boolean).map(String))],
    [events]
  );

  const [state, setState] = useState<MultiviewState>(() =>
    createInitialMultiviewState(initialStreams)
  );
  const listenersRef = useRef(
    new Set<(state: MultiviewState) => void>()
  );

  const stateRef = useRef(state);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    stateRef.current = state;
    for (const listener of listenersRef.current) {
      listener(state);
    }
  }, [state]);

  const update = useCallback(
    (updater: (current: MultiviewState) => MultiviewState) => {
      setState((current) => updater(current));
    },
    []
  );

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
      const eventKeys = [
        ...new Set(url.searchParams.getAll("event").filter(Boolean)),
      ];

      update((current) => ({
        ...current,
        streams: eventKeys,
        priority: eventKeys,
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

  const updateUrl = useCallback((eventKeys: string[]) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("event");

    for (const eventKey of eventKeys) {
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

  const handleMatchImminent = useCallback(
    (signal: string | MatchImminentSignal) => {
      const current = stateRef.current;

      if (!current.autoFocusMatches) {
        return;
      }

      const eventKey =
        typeof signal === "string" ? signal : signal.matchKey;

      if (!current.streams.includes(eventKey)) {
        return;
      }

      const layoutKey =
        current.layoutKey ??
        pickLayout(current.streams.length || 1);

      update((next) => ({
        ...next,
        activeKey: eventKey,
        highlightLayoutKey: pickHighlightLayout(
          LAYOUTS[layoutKey]?.slots.length ?? 1
        ),
      }));
    },
    [update]
  );

  const actions = useMemo<MultiviewActions>(
    () => ({
      showControls,
      hideControls,

      setAutoFocusMatches: (enabled) => {
        update((current) => ({
          ...current,
          autoFocusMatches: enabled,
        }));
      },

      handleMatchImminent,

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

        if (current.streams.includes(eventKey)) {
          return;
        }

        const nextStreams = [...current.streams, eventKey];

        update((next) => ({
          ...next,
          streams: nextStreams,
          priority: [...next.priority, eventKey],
          eventConfigs: {
            ...next.eventConfigs,
            [eventKey]: createEventViewConfig(),
          },
          eventPickerOpen: false,
        }));

        updateUrl(nextStreams);
        showControls();
      },

      removeEvent: (eventKey) => {
        const current = stateRef.current;
        const nextStreams = current.streams.filter(
          (key) => key !== eventKey
        );

        update((next) => ({
          ...next,
          streams: nextStreams,
          priority: next.priority.filter(
            (key) => key !== eventKey
          ),
          activeKey:
            next.activeKey === eventKey
              ? null
              : next.activeKey,
          highlightLayoutKey:
            next.activeKey === eventKey
              ? null
              : next.highlightLayoutKey,
          eventConfigs: Object.fromEntries(
            Object.entries(next.eventConfigs).filter(([key]) => key !== eventKey)
          ),
          labels: Object.fromEntries(
            Object.entries(next.labels).filter(
              ([key]) => key !== eventKey
            )
          ),
        }));

        updateUrl(nextStreams);
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
      handleMatchImminent,
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

  const ingestWebSocketEvent = useCallback(
    (
      event: MultiviewWebSocketEvent,
      handlers: MultiviewWebSocketHandlers
    ) => {
      if (event.type !== "tba-update") {
        return;
      }

      const messageType = event.messageType;

      if (!messageType) {
        return;
      }

      switch (messageType) {
        case "upcoming_match":
        case "match_score":
        case "match_video":
          handlers.refreshMatches();
          handlers.refreshStatuses();
          return;

        case "starting_comp_level":
        case "schedule_updated":
          handlers.refreshAll();
          return;

        case "alliance_selection":
          handlers.refreshAlliances();
          handlers.refreshStatuses();
          handlers.refreshMatches();
          return;

        default:
          handlers.refreshAll();
          return;
      }
    },
    []
  );

  const localController = useMemo<MultiviewController>(
    () => ({
      getState: () => stateRef.current,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
      actions,
      ingestWebSocketEvent,
    }),
    [actions, ingestWebSocketEvent]
  );

  return externalController ?? localController;
}

export function useMultiviewKeyboard(
  state: MultiviewState,
  actions: MultiviewActions
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
  }, [actions, state]);
}
