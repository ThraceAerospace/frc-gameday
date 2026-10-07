"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { PlusIcon } from "@heroicons/react/24/outline";
import EventView from "@/components/eventview/EventView";
import { LAYOUTS, pickLayout } from "@/lib/multiview/layouts";
import type { TileSurfaceController } from "./MultiviewActions";
import type { MultiviewState } from "./MultiviewState";
import type { EventViewPresentation } from "@/components/eventview/EventViewConfig";

type TileSurfaceProps = {
  controller: TileSurfaceController;
  isDivisional?: boolean;
  className?: string;
  renderEventView?: (args: {
    eventKey: string;
    controller: TileSurfaceController;
    config: MultiviewState["eventConfigs"][string] | undefined;
    slotPresentation: EventViewPresentation;
  }) => ReactNode;
};

function getSlotPresentation(
  geometry: (typeof LAYOUTS)[keyof typeof LAYOUTS]["slots"][number] | undefined,
): EventViewPresentation {
  return (
    geometry?.presentation ?? {
      teamTracker: "hidden",
      matchInfo: "visible",
    }
  );
}

export default function TileSurface({
  controller,
  isDivisional = false,
  className = "",
  renderEventView,
}: TileSurfaceProps) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  const autoLayoutKey = pickLayout(state.streams.length || 1);
  const selectedLayoutKey =
    state.highlightLayoutKey ?? state.layoutKey ?? autoLayoutKey;
  const layout = LAYOUTS[selectedLayoutKey] ?? LAYOUTS.single;

  const slotOrder =
    state.activeKey && state.priority.includes(state.activeKey)
      ? [
          state.activeKey,
          ...state.priority.filter(
            (eventKey) => eventKey !== state.activeKey,
          ),
        ]
      : state.priority;

  const emptySlotCount = Math.max(
    0,
    layout.slots.length - state.streams.length,
  );

  return (
    <main className={`relative min-h-0 flex-1 ${className}`}>
      {state.streams.map((eventKey) => {
        const slotIndex = slotOrder.indexOf(eventKey);
        const geometry = layout.slots[slotIndex];
        const slotPresentation = getSlotPresentation(geometry);
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
                    left: `${geometry!.x}%`,
                    top: `${geometry!.y}%`,
                    width: `${geometry!.w}%`,
                    height: `${geometry!.h}%`,
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
            {renderEventView ? (
              renderEventView({
                eventKey,
                controller,
                config: state.eventConfigs[eventKey],
                slotPresentation,
              })
            ) : (
              <EventView
                event={eventKey}
                isDivisional={isDivisional}
                controller={controller}
                config={state.eventConfigs[eventKey]}
                slotPresentation={slotPresentation}
              />
            )}
          </div>
        );
      })}

      {Array.from({ length: emptySlotCount }).map((_, index) => {
        const slotIndex = state.streams.length + index;
        const geometry = layout.slots[slotIndex];

        if (!geometry) return null;

        return (
          <button
            key={`empty-slot-${slotIndex}`}
            type="button"
            onClick={controller.actions.openEventPicker}
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
  );
}
