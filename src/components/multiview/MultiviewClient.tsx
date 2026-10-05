"use client";

import type { TBAEvent } from "@/lib/tba/types";
import { useSyncExternalStore } from "react";
import type { MultiviewController } from "./MultiviewActions";
import {
  LAYOUTS,
  pickLayout,
} from "@/lib/multiview/layouts";
import EventLocalTime from "@/components/gameday/match/EventLocalTime";
import GamedayWidget from "../gameday/GamedayWidget";
import { useRouter } from "next/navigation";

import { useMultiviewController, useMultiviewKeyboard } from "./MultiviewController";

import {
  HomeIcon,
  PlusIcon,
  Squares2X2Icon,
  XMarkIcon,
  ArrowDownIcon,
  ArrowUpIcon,
} from "@heroicons/react/24/outline";

type MultiviewClientProps = {
  events?: string[];
  isDivisional?: boolean;
  parentEvent?: TBAEvent | null;
  controller?: MultiviewController;
};

export default function MultiviewClient({
  events = [],
  isDivisional = false,
  parentEvent = null,
  controller,
}: MultiviewClientProps) {
  const router = useRouter();
  const multiviewController = useMultiviewController({
    events,
    controller,
  });
  const state = useSyncExternalStore(
    multiviewController.subscribe,
    multiviewController.getState,
    multiviewController.getState
  );
  const actions = multiviewController.actions;

  useMultiviewKeyboard(state, actions);

  const autoLayoutKey = pickLayout(state.streams.length || 1);
  const selectedLayoutKey =
    state.highlightLayoutKey ??
    state.layoutKey ??
    autoLayoutKey;
  const layout =
    LAYOUTS[selectedLayoutKey] ?? LAYOUTS.single;

  const slotOrder =
    state.activeKey &&
    state.priority.includes(state.activeKey)
      ? [
          state.activeKey,
          ...state.priority.filter(
            (eventKey) => eventKey !== state.activeKey
          ),
        ]
      : state.priority;

  const activeEventKeys = new Set(state.streams);

  const filteredEvents = state.availableEvents
    .filter(
      (event) => !activeEventKeys.has(String(event.key))
    )
    .filter((event) => {
      const query = state.eventSearch.trim().toLowerCase();

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
          String(value).toLowerCase().includes(query)
        );
    });

  const emptySlotCount = Math.max(
    0,
    layout.slots.length - state.streams.length
  );

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-black text-white"
      onMouseEnter={actions.showControls}
      onMouseMove={actions.showControls}
    >
      <header
        className={`flex shrink-0 items-center justify-between overflow-hidden border-b border-neutral-800 bg-black/90 px-2 backdrop-blur-sm transition-[height,border-color] duration-200 ease-out ${
          state.controlsVisible
            ? "h-10"
            : "h-0 border-b-transparent"
        }`}
        onMouseEnter={actions.showControls}
        onMouseMove={actions.showControls}
        onFocus={actions.showControls}
      >
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => router.push("/")}
            className="h-[30px] w-[30px] rounded hover:bg-stone-800"
            title="Home"
          >
            <HomeIcon className="h-[17px] w-[17px] justify-self-center" />
          </button>

          {isDivisional && parentEvent ? (
            <div className="min-w-0">
              <div className="truncate text-sm font-bold">
                {parentEvent.name}
              </div>
              <div className="text-[10px] text-neutral-500">
                <EventLocalTime timezone={parentEvent.timezone} />
              </div>
            </div>
          ) : (
            <div>
              <div className="text-sm font-bold">FieldView</div>
              <div className="text-[10px] text-neutral-500">
                Powered by The Blue Alliance
              </div>
            </div>
          )}
        </div>

        <div className="flex min-w-0 gap-1 overflow-hidden">
          {state.streams.map((eventKey, index) => (
            <button
              key={eventKey}
              onClick={() => actions.toggleActive(eventKey)}
              className={`max-w-48 truncate rounded bg-stone-800 px-2 py-1 ${
                state.priorityEditKey === eventKey
                  ? "inset-ring-2 inset-ring-blue-500"
                  : ""
              } ${
                state.activeKey === eventKey
                  ? "inset-ring-2 inset-ring-white"
                  : ""
              }`}
            >
              {(state.labels[eventKey] ?? `Stream ${index + 1}`).replace(
                "- FIRST Robotics Competition",
                ""
              )}
            </button>
          ))}
        </div>

        <button
          onClick={actions.toggleSidebar}
          className="h-[30px] w-[30px] rounded hover:bg-stone-800"
          title="Multiview settings"
        >
          <Squares2X2Icon className="h-[17px] w-[17px] justify-self-center" />
        </button>
      </header>

      <main className="relative min-h-0 flex-1">
        {state.streams.map((eventKey) => {
          const slotIndex = slotOrder.indexOf(eventKey);
          const geometry = layout.slots[slotIndex];
          const slotPresentation =
            geometry?.presentation ?? {
              teamTracker: "sides" as const,
              matchInfo: "visible" as const,
            };

          const visible = Boolean(geometry);

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
                      transition: "all 300ms ease",
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
                isDivisional={isDivisional}
                registerLabel={(label) =>
                  actions.registerLabel(eventKey, label)
                }
                onMatchImminent={() =>
                  actions.handleMatchImminent(eventKey)
                }
                multiview={{ presentation: slotPresentation }}
              />
            </div>
          );
        })}

        {Array.from({ length: emptySlotCount }).map((_, index) => {
          const slotIndex = state.streams.length + index;
          const geometry = layout.slots[slotIndex];

          if (!geometry) {
            return null;
          }

          return (
            <button
              key={`empty-slot-${slotIndex}`}
              onClick={actions.openEventPicker}
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
                <span className="text-sm font-semibold">Add Event</span>
              </div>
            </button>
          );
        })}
      </main>

      <div
        onClick={() => actions.setSidebarOpen(false)}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity ${
          state.sidebarOpen
            ? "opacity-100"
            : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-[clamp(280px,25vw,400px)] flex-col border-l border-neutral-700 bg-neutral-900 p-3 shadow-xl transition-transform ${
          state.sidebarOpen
            ? "translate-x-0"
            : "translate-x-full"
        }`}
      >
        <div className="mb-3 shrink-0 font-bold">Multiview</div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="mb-4 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white">
                  Focus imminent matches
                </div>
                <div className="mt-1 text-[10px] leading-4 text-neutral-500">
                  Automatically highlight an event when a tracked team's
                  match is approaching.
                </div>
              </div>
              <input
                type="checkbox"
                checked={state.autoFocusMatches}
                onChange={(event) =>
                  actions.setAutoFocusMatches(event.target.checked)
                }
                className="h-4 w-4 shrink-0"
              />
            </label>
          </div>

          <div className="mb-4 space-y-1">
            {state.priority.map((eventKey, position) => (
              <div
                key={eventKey}
                className="flex items-center justify-between rounded bg-neutral-800 px-2 py-1"
              >
                <span className="truncate text-xs">
                  {state.labels[eventKey] ?? `Stream ${position + 1}`}
                </span>

                <div className="flex gap-1">
                  <button
                    onClick={() => actions.movePriority(position, -1)}
                    className="icon-button"
                    title="Move up"
                  >
                    <ArrowUpIcon />
                  </button>
                  <button
                    onClick={() => actions.movePriority(position, 1)}
                    className="icon-button"
                    title="Move down"
                  >
                    <ArrowDownIcon />
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.removeEvent(eventKey)}
                    className="icon-button shrink-0"
                    title={`Remove ${state.labels[eventKey] ?? eventKey}`}
                    aria-label={`Remove ${state.labels[eventKey] ?? eventKey}`}
                  >
                    <XMarkIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mb-1 font-bold">Layouts</div>

          <button
            onClick={actions.resetLayout}
            className={`mt-2 block w-full rounded px-2 py-1 text-left text-sm ${
              state.layoutKey === null
                ? "bg-green-700"
                : "hover:bg-neutral-800"
            }`}
          >
            Auto Layout ({LAYOUTS[autoLayoutKey].name})
          </button>

          {Object.entries(LAYOUTS).map(([key, value]) => (
            <button
              key={key}
              onClick={() =>
                actions.setLayout(key as keyof typeof LAYOUTS)
              }
              className={`block w-full rounded px-2 py-1 text-left text-sm ${
                selectedLayoutKey === key
                  ? "bg-neutral-700"
                  : "hover:bg-neutral-800"
              }`}
            >
              {value.name}
            </button>
          ))}
        </div>
      </aside>

      {state.eventPickerOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={actions.closeEventPicker}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <div className="font-bold">Add Event</div>
              <button
                onClick={actions.closeEventPicker}
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
                value={state.eventSearch}
                onChange={(event) =>
                  actions.setEventSearch(event.target.value)
                }
                placeholder="Search events..."
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              />
            </div>

            <div className="min-h-0 overflow-y-auto p-2">
              {state.eventsLoading ? (
                <div className="p-6 text-center text-sm text-neutral-500">
                  Loading events...
                </div>
              ) : filteredEvents.length === 0 ? (
                <div className="p-6 text-center text-sm text-neutral-500">
                  No matching events.
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredEvents.map((event: TBAEvent) => (
                    <button
                      key={event.key}
                      onClick={() => actions.addEvent(event)}
                      className="w-full rounded px-3 py-2 text-left transition-colors hover:bg-neutral-800"
                    >
                      <div className="truncate text-sm font-semibold">
                        {event.name ?? event.short_name ?? event.key}
                      </div>
                      <div className="mt-0.5 flex gap-2 text-xs text-neutral-500">
                        <span>{event.key}</span>
                        {event.city && (
                          <span>
                            {event.city}
                            {event.state_prov
                              ? `, ${event.state_prov}`
                              : ""}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
