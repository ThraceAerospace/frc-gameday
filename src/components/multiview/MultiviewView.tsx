"use client";

import type { TBAEvent } from "@/lib/tba/types";
import { useSyncExternalStore } from "react";
import MultiviewSettings from "./MultiviewSettings";
import type { MultiviewController } from "./MultiviewActions";
import {
  LAYOUTS,
  pickLayout,
} from "@/lib/multiview/layouts";

import { useRouter } from "next/navigation";

import { useMultiviewController, useMultiviewKeyboard } from "./MultiviewController";

import {
  HomeIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import EventView from "@/components/eventview/EventView";
import EventLocalTime from "@/components/eventview/match/EventLocalTime";

type MultiviewViewProps = {
  events?: string[];
  isDivisional?: boolean;
  parentEvent?: TBAEvent | null;
  controller?: MultiviewController;
};

export default function MultiviewView({
  events = [],
  isDivisional = false,
  parentEvent = null,
  controller,
}: MultiviewViewProps) {
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

        <MultiviewSettings state={state} actions={actions} />
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
              <EventView
                event={eventKey}
                isDivisional={isDivisional}
                controller={multiviewController}
                config={state.eventConfigs[eventKey]}
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

    </div>
  );
}
