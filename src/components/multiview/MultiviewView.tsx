"use client";

import type { TBAEvent } from "@/lib/tba/types";
import { useSyncExternalStore } from "react";
import MultiviewSettings from "./MultiviewSettings";
import type { MultiviewController } from "./MultiviewActions";

import { useRouter } from "next/navigation";

import { useMultiviewController, useMultiviewKeyboard } from "./MultiviewController";

import {
  HomeIcon,
} from "@heroicons/react/24/outline";
import EventLocalTime from "@/components/event/EventLocalTime";
import MultiviewStage from "./MultiviewStage";

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

      <MultiviewStage
        controller={multiviewController}
        isDivisional={isDivisional}
      />
    </div>
  );
}
