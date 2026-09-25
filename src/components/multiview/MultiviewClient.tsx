"use client";

import type { TBAEvent } from "@/lib/tba/types";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  HomeIcon,
  PlusIcon,
  Squares2X2Icon,
  XMarkIcon,
  ArrowDownIcon,
  ArrowUpIcon,
} from "@heroicons/react/24/outline";

import {
  LAYOUTS,
  pickLayout,
  pickHighlightLayout,
} from "@/lib/multiview/layouts";
import EventLocalTime from "../gameday/navbar/EventLocalTime";
import GamedayWidget from "../gameday/GamedayWidget";

const CONTROLS_HIDE_DELAY = 3000;

type MultiviewClientProps = { events?: string[]; isDivisional?: boolean; parentEvent?: TBAEvent | null };

export default function MultiviewClient({
  events = [],
  isDivisional = false,
  parentEvent = null,
}: MultiviewClientProps) {
  const router = useRouter();

  /*
   * `streams` is the stable set of widgets Multiview owns.
   *
   * IMPORTANT:
   * This array is never reordered.
   *
   * React therefore sees the same GamedayWidget siblings
   * for the entire lifetime of Multiview.
   */
  const initialStreams = useMemo(
    () => [
      ...new Set(
        events
          .filter(Boolean)
          .map((event) => String(event))
      ),
    ],
    [events]
  );

  const [streams, setStreams] =
    useState(initialStreams);

  /*
   * `priority` controls which widget occupies which
   * layout slot.
   *
   * This is deliberately separate from `streams`.
   */
  const [priority, setPriority] =
    useState(initialStreams);

  /*
   * Explicitly selected layout.
   *
   * null means use the automatically selected layout.
   */
  const [layoutKey, setLayoutKey] =
    useState(null);

  /*
   * When a widget is highlighted, `activeKey` is promoted
   * to slot zero.
   */
  const [activeKey, setActiveKey] =
    useState(null);

  /*
   * When a widget is highlighted, this temporarily replaces
   * the normal layout.
   *
   * null means no highlight layout is active.
   */
  const [
    highlightLayoutKey,
    setHighlightLayoutKey,
  ] = useState(null);

  const [sidebarOpen, setSidebarOpen] =
    useState(false);

  /*
   * Automatic match-imminence focusing is intentionally
   * session-only for now. No localStorage.
   */
  const [
    autoFocusMatches,
    setAutoFocusMatches,
  ] = useState(true);

  const [
    eventPickerOpen,
    setEventPickerOpen,
  ] = useState(false);

  const [
    eventSearch,
    setEventSearch,
  ] = useState("");

  const [
    availableEvents,
    setAvailableEvents,
  ] = useState([]);

  const [
    eventsLoading,
    setEventsLoading,
  ] = useState(false);

  /*
   * Labels are metadata about widgets themselves.
   *
   * They must never depend on slot order.
   */
  const [labels, setLabels] =
    useState({});

  /*
   * Multiview controls idle state.
   *
   * The header remains part of the normal flex layout.
   * When visible it consumes 40px of vertical space.
   * When hidden it collapses to 0px, allowing the main
   * video area to reclaim that space.
   */
  const [controlsVisible, setControlsVisible] =
    useState(true);

  const controlsTimeoutRef =
    useRef(null);

  const clearControlsTimeout =
    useCallback(() => {
      if (controlsTimeoutRef.current) {
        clearTimeout(
          controlsTimeoutRef.current
        );

        controlsTimeoutRef.current = null;
      }
    }, []);

  const showControls =
    useCallback(() => {
      setControlsVisible(true);

      clearControlsTimeout();

      /*
       * Dialogs keep the controls visible.
       */
      if (
        sidebarOpen ||
        eventPickerOpen
      ) {
        return;
      }

      controlsTimeoutRef.current =
        setTimeout(() => {
          setControlsVisible(false);
          controlsTimeoutRef.current = null;
        }, CONTROLS_HIDE_DELAY);
    }, [
      clearControlsTimeout,
      sidebarOpen,
      eventPickerOpen,
    ]);

  /*
   * Start the idle timer on mount.
   */
  useEffect(() => {
    showControls();

    return () => {
      clearControlsTimeout();
    };
  }, [
    showControls,
    clearControlsTimeout,
  ]);

  /*
   * Keep controls visible while dialogs are open.
   * Restart the idle timer after they close.
   */
  useEffect(() => {
    if (
      sidebarOpen ||
      eventPickerOpen
    ) {
      clearControlsTimeout();
      setControlsVisible(true);
      return;
    }

    showControls();
  }, [
    sidebarOpen,
    eventPickerOpen,
    clearControlsTimeout,
    showControls,
  ]);

  /*
   * The normal layout is based on the number of streams.
   */
  const autoLayoutKey =
    pickLayout(
      streams.length || 1
    );

  /*
   * The user's explicit layout wins over auto layout.
   */
  const baseLayoutKey =
    layoutKey ?? autoLayoutKey;

  /*
   * A highlight layout temporarily overrides the base layout.
   */
  const selectedLayoutKey =
    highlightLayoutKey ??
    baseLayoutKey;

  const layout =
    LAYOUTS[selectedLayoutKey] ??
    LAYOUTS.single;

  /*
   * Promote activeKey to slot zero without changing
   * priority itself.
   *
   * This means manually highlighting or automatically
   * focusing an event does not permanently reorder the
   * user's priority list.
   */
  const slotOrder = useMemo(() => {
    if (
      !activeKey ||
      !priority.includes(activeKey)
    ) {
      return priority;
    }

    return [
      activeKey,
      ...priority.filter(
        (eventKey) =>
          eventKey !== activeKey
      ),
    ];
  }, [
    activeKey,
    priority,
  ]);

  /*
   * A GamedayWidget reports its label using its stable
   * event key.
   */
  const registerLabel = useCallback(
    (eventKey, label) => {
      setLabels((current) => {
        if (
          current[eventKey] === label
        ) {
          return current;
        }

        return {
          ...current,
          [eventKey]: label,
        };
      });
    },
    []
  );

  /*
   * Remove labels for widgets that no longer exist.
   *
   * Priority changes do not affect labels.
   */
  useEffect(() => {
    setLabels((current) => {
      let changed = false;
      const next = {};

      for (const [
        eventKey,
        label,
      ] of Object.entries(current)) {
        if (
          streams.includes(
            eventKey
          )
        ) {
          next[eventKey] =
            label;
        } else {
          changed = true;
        }
      }

      return changed
        ? next
        : current;
    });
  }, [streams]);

  /*
   * Move only the priority array.
   */
  const move = useCallback(
    (position, direction) => {
      setPriority((current) => {
        const target =
          position + direction;

        if (
          target < 0 ||
          target >= current.length
        ) {
          return current;
        }

        const next = [
          ...current,
        ];

        [
          next[position],
          next[target],
        ] = [
          next[target],
          next[position],
        ];

        return next;
      });
    },
    []
  );

  /*
   * Update only the event portion of the URL.
   */
  const updateUrl = useCallback(
    (eventKeys) => {
      const url =
        new URL(
          window.location.href
        );

      url.searchParams.delete(
        "event"
      );

      for (const eventKey of eventKeys) {
        url.searchParams.append(
          "event",
          eventKey
        );
      }

      window.history.pushState(
        {},
        "",
        url
      );
    },
    []
  );

  /*
   * Browser Back / Forward reconstructs the event set.
   */
  useEffect(() => {
    const handlePopState = () => {
      const url =
        new URL(
          window.location.href
        );

      const eventKeys = [
        ...new Set(
          url.searchParams
            .getAll("event")
            .filter(Boolean)
        ),
      ];

      setStreams(eventKeys);
      setPriority(eventKeys);
      setActiveKey(null);
      setHighlightLayoutKey(null);
    };

    window.addEventListener(
      "popstate",
      handlePopState
    );

    return () => {
      window.removeEventListener(
        "popstate",
        handlePopState
      );
    };
  }, []);

  /*
   * Automatic focus from match imminence.
   *
   * The widget only reports that its tracked match is
   * imminent. Multiview owns the policy decision.
   */
  const handleMatchImminent =
    useCallback(
      (eventKey) => {
        if (!autoFocusMatches) {
          return;
        }

        if (
          !streams.includes(
            eventKey
          )
        ) {
          return;
        }

        const highlightKey =
          pickHighlightLayout(
            layout.slots.length
          );

        setActiveKey(eventKey);
        setHighlightLayoutKey(
          highlightKey
        );
      },
      [
        autoFocusMatches,
        streams,
        layout.slots.length,
      ]
    );

  /*
   * Manual highlighting.
   */
  const toggleActive = useCallback(
    (eventKey) => {
      showControls();

      if (
        activeKey === eventKey
      ) {
        setActiveKey(null);
        setHighlightLayoutKey(
          null
        );
        return;
      }

      setActiveKey(eventKey);

      setHighlightLayoutKey(
        pickHighlightLayout(
          layout.slots.length
        )
      );
    },
    [
      activeKey,
      layout.slots.length,
      showControls,
    ]
  );

  /*
   * preserve eventKey from pressing ctrl+[1-9] for visual
   * reordering without opening the side bar
   */
  const [
    priorityEditKey,
    setPriorityEditKey,
  ] = useState(null);

  const movePriorityEdit = useCallback(
    (direction) => {
      if (!priorityEditKey) {
        return;
      }

      setPriority((current) => {
        const position =
          current.indexOf(
            priorityEditKey
          );

        if (position === -1) {
          return current;
        }

        const target =
          position + direction;

        if (
          target < 0 ||
          target >= current.length
        ) {
          return current;
        }

        const next = [...current];

        [
          next[position],
          next[target],
        ] = [
          next[target],
          next[position],
        ];

        return next;
      });
    },
    [priorityEditKey]
  );

  /*
   * Keyboard controls.
   *
   * 1-9 select the corresponding stream by stable stream order.
   * 0 clears the active highlight.
   *
   * Once a stream is selected:
   *   ArrowUp   moves it earlier in priority.
   *   ArrowDown moves it later in priority.
   */
  useEffect(() => {
    const handleKeyDown = (event) => {
      const target =
        event.target;

      if (
        target instanceof
          HTMLInputElement ||
        target instanceof
          HTMLTextAreaElement ||
        target instanceof
          HTMLSelectElement ||
        target instanceof
          HTMLButtonElement ||
        target?.isContentEditable
      ) {
        return;
      }

      /*
       * Keyboard interaction is also activity.
       */
      showControls();

      if (
        event.key >= "1" &&
        event.key <= "9"
      ) {
        event.preventDefault();

        const index =
          Number(event.key) - 1;

        const eventKey =
          streams[index];

        if (!eventKey) {
          return;
        }

        if (event.ctrlKey) {
          if (
            priorityEditKey ===
            eventKey
          ) {
            setPriorityEditKey(
              null
            );
            return;
          }

          setPriorityEditKey(
            eventKey
          );

          return;
        }

        toggleActive(
          eventKey
        );

        return;
      }

      if (event.key === "0") {
        setActiveKey(null);
        setHighlightLayoutKey(
          null
        );

        return;
      }

      if (
        event.key === "-" ||
        event.key === "="
      ) {
        const layoutKeys =
          Object.keys(
            LAYOUTS
          );

        const currentKey =
          layoutKey ??
          autoLayoutKey;

        const currentIndex =
          layoutKeys.indexOf(
            currentKey
          );

        const direction =
          event.key === "-"
            ? -1
            : 1;

        const nextIndex =
          currentIndex +
          direction;

        if (
          nextIndex < 0 ||
          nextIndex >=
            layoutKeys.length
        ) {
          return;
        }

        const nextKey =
          layoutKeys[
            nextIndex
          ];

        console.log(
          "Setting Layout Key to",
          nextKey
        );

        setLayoutKey(
          nextKey
        );

        setHighlightLayoutKey(
          null
        );

        return;
      }

      if (
        event.key ===
          "ArrowUp" &&
        priorityEditKey
      ) {
        console.log(
          "Moving",
          priorityEditKey,
          "Up"
        );

        movePriorityEdit(
          -1
        );

        return;
      }

      if (
        event.key ===
          "ArrowDown" &&
        priorityEditKey
      ) {
        console.log(
          "Moving",
          priorityEditKey,
          "Down"
        );

        movePriorityEdit(
          1
        );
      }
    };

    window.addEventListener(
      "keydown",
      handleKeyDown
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handleKeyDown
      );
    };
  }, [
    streams,
    activeKey,
    priorityEditKey,
    layoutKey,
    autoLayoutKey,
    toggleActive,
    movePriorityEdit,
    showControls,
  ]);

  /*
   * Fetch active events only when the picker is opened.
   */
  useEffect(() => {
    if (!eventPickerOpen) {
      return;
    }

    let cancelled = false;

    async function loadEvents() {
      setEventsLoading(true);

      try {
        const response =
          await fetch(
            "/api/events/active",
            {
              cache: "no-store",
            }
          );

        if (!response.ok) {
          throw new Error(
            `Failed to load events: ${response.status}`
          );
        }

        const data =
          await response.json();

        if (!cancelled) {
          setAvailableEvents(
            Array.isArray(data)
              ? data
              : []
          );
        }
      } catch (error) {
        console.error(
          "Failed to load active events:",
          error
        );

        if (!cancelled) {
          setAvailableEvents(
            []
          );
        }
      } finally {
        if (!cancelled) {
          setEventsLoading(
            false
          );
        }
      }
    }

    loadEvents();

    return () => {
      cancelled = true;
    };
  }, [eventPickerOpen]);

  const openEventPicker =
    useCallback(() => {
      showControls();
      setEventSearch("");
      setEventPickerOpen(
        true
      );
    }, [showControls]);

  const addEvent = useCallback(
    (event) => {
      const eventKey =
        String(event.key);

      if (
        streams.includes(
          eventKey
        )
      ) {
        return;
      }

      const nextStreams = [
        ...streams,
        eventKey,
      ];

      setStreams(
        nextStreams
      );

      setPriority((current) => [
        ...current,
        eventKey,
      ]);

      updateUrl(
        nextStreams
      );

      setEventPickerOpen(
        false
      );

      showControls();
    },
    [
      streams,
      updateUrl,
      showControls,
    ]
  );

  const removeEvent =
    useCallback(
      (eventKey) => {
        const nextStreams =
          streams.filter(
            (key) =>
              key !== eventKey
          );

        setStreams(
          nextStreams
        );

        setPriority((current) =>
          current.filter(
            (key) =>
              key !== eventKey
          )
        );

        setActiveKey((current) =>
          current === eventKey
            ? null
            : current
        );

        setHighlightLayoutKey(
          (current) =>
            activeKey === eventKey
              ? null
              : current
        );

        setLabels((current) => {
          if (
            !(eventKey in current)
          ) {
            return current;
          }

          const next = {
            ...current,
          };

          delete next[eventKey];

          return next;
        });

        updateUrl(
          nextStreams
        );

        showControls();
      },
      [
        streams,
        activeKey,
        updateUrl,
        showControls,
      ]
    );

  const activeEventKeys =
    useMemo(
      () =>
        new Set(streams),
      [streams]
    );

  const filteredEvents =
    useMemo(() => {
      const query =
        eventSearch
          .trim()
          .toLowerCase();

      return availableEvents
        .filter(
          (event) =>
            !activeEventKeys.has(
              String(event.key)
            )
        )
        .filter((event) => {
          if (!query) {
            return true;
          }

          return [
            event.name,
            event.short_name,
            event.key,
            event.city,
            event.state_prov,
            event.country,
          ]
            .filter(Boolean)
            .some((value) =>
              String(value)
                .toLowerCase()
                .includes(
                  query
                )
            );
        });
    }, [
      availableEvents,
      activeEventKeys,
      eventSearch,
    ]);

  /*
   * Empty slots are always the slots after the occupied
   * streams in the current layout.
   */
  const emptySlotCount =
    Math.max(
      0,
      layout.slots.length -
        streams.length
    );

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-black text-white"
      onMouseEnter={showControls}
      onMouseMove={showControls}
    >
      {/*
       * IMPORTANT:
       *
       * This header is deliberately NOT absolute.
       *
       * While visible it consumes 40px of actual layout
       * space. When hidden it collapses to 0px, causing
       * the main area to grow into that space.
       *
       * This means the YouTube iframe is never underneath
       * the header.
       */}
      <header
        className={`flex shrink-0 items-center justify-between overflow-hidden border-b border-neutral-800 bg-black/90 px-2 backdrop-blur-sm transition-[height,border-color] duration-200 ease-out ${
          controlsVisible
            ? "h-10"
            : "h-0 border-b-transparent"
        }`}
        onMouseEnter={showControls}
        onMouseMove={showControls}
        onFocus={showControls}
      >
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => {
              showControls();
              router.push("/");
            }}
            className="h-[30px] w-[30px] rounded hover:bg-stone-800"
            title="Home"
          >
            <HomeIcon className="h-[17px] w-[17px] justify-self-center" />
          </button>

          {isDivisional &&
          parentEvent ? (
            <div className="min-w-0">
              <div className="truncate text-sm font-bold">
                {parentEvent.name}
              </div>

              <div className="text-[10px] text-neutral-500">
                <EventLocalTime
                  timezone={
                    parentEvent.timezone
                  }
                />
              </div>
            </div>
          ) : (
            <div>
              <div className="text-sm font-bold">
                FieldView
              </div>

              <div className="text-[10px] text-neutral-500">
                Powered by The Blue Alliance
              </div>
            </div>
          )}
        </div>

        {/*
         * Labels belong to widgets, not slots.
         *
         * Keep this mapped over `streams`.
         */}
        <div className="flex min-w-0 gap-1 overflow-hidden">
          {streams.map(
            (
              eventKey,
              index
            ) => (
              <button
                key={eventKey}
                onClick={() =>
                  toggleActive(
                    eventKey
                  )
                }
                className={`max-w-48 truncate rounded bg-stone-800 px-2 py-1 ${
                  priorityEditKey ===
                  eventKey
                    ? "inset-ring-2 inset-ring-blue-500"
                    : ""
                } ${
                  activeKey ===
                  eventKey
                    ? "inset-ring-2 inset-ring-white"
                    : ""
                }`}
              >
                {(
                  labels[
                    eventKey
                  ] ??
                  `Stream ${
                    index + 1
                  }`
                ).replace(
                  "- FIRST Robotics Competition",
                  ""
                )}
              </button>
            )
          )}
        </div>

        <button
          onClick={() => {
            showControls();

            setSidebarOpen(
              (value) =>
                !value
            );
          }}
          className="h-[30px] w-[30px] rounded hover:bg-stone-800"
          title="Multiview settings"
        >
          <Squares2X2Icon className="h-[17px] w-[17px] justify-self-center" />
        </button>
      </header>

      {/*
       * The main area is now the flex child.
       *
       * When the header is h-10:
       *     main = viewport - 40px
       *
       * When the header is h-0:
       *     main = viewport
       *
       * There is no overlay over the video at either state.
       */}
      <main className="relative min-h-0 flex-1">
        {streams.map(
          (eventKey) => {
            const slotIndex =
              slotOrder.indexOf(
                eventKey
              );

            const geometry =
              layout.slots[
                slotIndex
              ];

            const slotPresentation =
              geometry?.presentation ??
              {
                teamTracker:
                  "sides",
                matchInfo:
                  "visible",
              };

            const visible =
              Boolean(
                geometry
              );

            return (
              <div
                key={eventKey}
                className={
                  visible
                    ? "absolute"
                    : "pointer-events-none absolute invisible"
                }
                style={
                  visible
                    ? {
                        left: `${geometry.x}%`,
                        top: `${geometry.y}%`,
                        width: `${geometry.w}%`,
                        height: `${geometry.h}%`,
                        transition:
                          "all 300ms ease",
                      }
                    : {
                        left: 0,
                        top: 0,
                        width: 1,
                        height: 1,
                      }
                }
              >
                <GamedayWidget
                  event={eventKey}
                  isDivisional={
                    isDivisional
                  }
                  registerLabel={(
                    label
                  ) =>
                    registerLabel(
                      eventKey,
                      label
                    )
                  }
                  onMatchImminent={() =>
                    handleMatchImminent(
                      eventKey
                    )
                  }
                  multiview={{
                    layoutKey:
                      selectedLayoutKey,
                    presentation:
                      slotPresentation,
                    slotIndex,
                    visible,
                  }}
                />
              </div>
            );
          }
        )}

        {Array.from({
          length:
            emptySlotCount,
        }).map(
          (_, index) => {
            const slotIndex =
              streams.length +
              index;

            const geometry =
              layout.slots[
                slotIndex
              ];

            if (!geometry) {
              return null;
            }

            return (
              <button
                key={`empty-slot-${slotIndex}`}
                onClick={
                  openEventPicker
                }
                className="absolute flex items-center justify-center border border-dashed border-neutral-700 bg-neutral-950/80 transition-colors hover:border-neutral-500 hover:bg-neutral-900"
                style={{
                  left: `${geometry.x}%`,
                  top: `${geometry.y}%`,
                  width: `${geometry.w}%`,
                  height: `${geometry.h}%`,
                }}
              >
                <div className="flex flex-col items-center gap-2 text-neutral-500">
                  <PlusIcon className="h-8 w-8" />

                  <span className="text-sm font-semibold">
                    Add Event
                  </span>
                </div>
              </button>
            );
          }
        )}
      </main>

      <div
        onClick={() => {
          setSidebarOpen(false);
          showControls();
        }}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity ${
          sidebarOpen
            ? "opacity-100"
            : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-[clamp(280px,25vw,400px)] flex-col border-l border-neutral-700 bg-neutral-900 p-3 shadow-xl transition-transform ${
          sidebarOpen
            ? "translate-x-0"
            : "translate-x-full"
        }`}
      >
        <div className="mb-3 shrink-0 font-bold">
          Multiview
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="mb-4 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white">
                  Focus imminent matches
                </div>

                <div className="mt-1 text-[10px] leading-4 text-neutral-500">
                  Automatically highlight an event when
                  a tracked team's match is approaching.
                </div>
              </div>

              <input
                type="checkbox"
                checked={autoFocusMatches}
                onChange={(event) =>
                  setAutoFocusMatches(
                    event.target.checked
                  )
                }
                className="h-4 w-4 shrink-0"
              />
            </label>
          </div>

          <div className="mb-4 space-y-1">
            {priority.map(
              (
                eventKey,
                position
              ) => (
                <div
                  key={eventKey}
                  className="flex items-center justify-between rounded bg-neutral-800 px-2 py-1"
                >
                  <span className="truncate text-xs">
                    {labels[
                      eventKey
                    ] ??
                      `Stream ${
                        position + 1
                      }`}
                  </span>

                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        showControls();
                        move(
                          position,
                          -1
                        );
                      }}
                      className="icon-button"
                      title="Move up"
                    >
                      <ArrowUpIcon />
                    </button>

                    <button
                      onClick={() => {
                        showControls();
                        move(
                          position,
                          1
                        );
                      }}
                      className="icon-button"
                      title="Move down"
                    >
                      <ArrowDownIcon />
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        removeEvent(
                          eventKey
                        )
                      }
                      className="icon-button shrink-0"
                      title={`Remove ${
                        labels[
                          eventKey
                        ] ??
                        eventKey
                      }`}
                      aria-label={`Remove ${
                        labels[
                          eventKey
                        ] ??
                        eventKey
                      }`}
                    >
                      <XMarkIcon />
                    </button>
                  </div>
                </div>
              )
            )}
          </div>

          <div className="mb-1 font-bold">
            Layouts
          </div>

          <button
            onClick={() => {
              setLayoutKey(null);
              setHighlightLayoutKey(
                null
              );
              showControls();
            }}
            className={`mt-2 block w-full rounded px-2 py-1 text-left text-sm ${
              layoutKey === null
                ? "bg-green-700"
                : "hover:bg-neutral-800"
            }`}
          >
            Auto Layout (
            {
              LAYOUTS[
                autoLayoutKey
              ].name
            }
            )
          </button>

          {Object.entries(
            LAYOUTS
          ).map(
            ([key, value]) => (
              <button
                key={key}
                onClick={() => {
                  setLayoutKey(
                    key
                  );
                  setHighlightLayoutKey(
                    null
                  );
                  showControls();
                }}
                className={`block w-full rounded px-2 py-1 text-left text-sm ${
                  selectedLayoutKey ===
                  key
                    ? "bg-neutral-700"
                    : "hover:bg-neutral-800"
                }`}
              >
                {value.name}
              </button>
            )
          )}
        </div>
      </aside>

      {eventPickerOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={() => {
            setEventPickerOpen(
              false
            );
            showControls();
          }}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <div className="font-bold">
                Add Event
              </div>

              <button
                onClick={() => {
                  setEventPickerOpen(
                    false
                  );
                  showControls();
                }}
                className="icon-button"
                title="Close"
              >
                <XMarkIcon />
              </button>
            </div>

            <div className="border-b border-neutral-800 p-3">
              <input
                autoFocus
                type="text"
                value={eventSearch}
                onChange={(event) =>
                  setEventSearch(
                    event.target.value
                  )
                }
                placeholder="Search events..."
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              />
            </div>

            <div className="min-h-0 overflow-y-auto p-2">
              {eventsLoading ? (
                <div className="p-6 text-center text-sm text-neutral-500">
                  Loading events...
                </div>
              ) : filteredEvents.length ===
                0 ? (
                <div className="p-6 text-center text-sm text-neutral-500">
                  No matching events.
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredEvents.map(
                    (event) => (
                      <button
                        key={
                          event.key
                        }
                        onClick={() =>
                          addEvent(
                            event
                          )
                        }
                        className="w-full rounded px-3 py-2 text-left transition-colors hover:bg-neutral-800"
                      >
                        <div className="truncate text-sm font-semibold">
                          {event.name ??
                            event.short_name ??
                            event.key}
                        </div>

                        <div className="mt-0.5 flex gap-2 text-xs text-neutral-500">
                          <span>
                            {
                              event.key
                            }
                          </span>

                          {event.city && (
                            <span>
                              {
                                event.city
                              }
                              {event.state_prov
                                ? `, ${event.state_prov}`
                                : ""}
                            </span>
                          )}
                        </div>
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}