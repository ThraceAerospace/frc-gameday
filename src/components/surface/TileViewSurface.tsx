"use client";

import type { TBAEvent } from "@/lib/tba/types";
import { useEffect, useState, useSyncExternalStore } from "react";
import TileSurfaceSettingsView from "./TileSurfaceSettingsView";
import type { TileSurfaceController } from "./TileSurfaceActions";

import { useRouter } from "next/navigation";

import { useTileSurfaceController, useTileSurfaceKeyboard } from "./TileSurfaceController";

import {
  HomeIcon,
} from "@heroicons/react/24/outline";
import EventLocalTime from "@/components/event/EventLocalTime";
import TileView from "./TileView";

type TileViewSurfaceProps = {
  events?: string[];
  isDivisional?: boolean;
  parentEvent?: TBAEvent | null;
  controller?: TileSurfaceController;
};

export default function TileViewSurface({
  events = [],
  isDivisional = false,
  parentEvent = null,
  controller,
}: TileViewSurfaceProps) {
  const router = useRouter();
  const tileSurfaceController = useTileSurfaceController({
    events,
    controller,
  });
  const state = useSyncExternalStore(
    tileSurfaceController.subscribe,
    tileSurfaceController.getState,
    tileSurfaceController.getState
  );
  const actions = tileSurfaceController.actions;
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The event picker is rendered inside the settings portal. If an empty tile
  // opens it directly, open the owning panel as well so the picker is visible.
  useEffect(() => {
    if (state.eventPickerOpen) {
      setSettingsOpen(true);
    }
  }, [state.eventPickerOpen]);

  useTileSurfaceKeyboard(state, actions, () => setSettingsOpen((open) => !open));

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-black text-white"
      onMouseEnter={actions.showControls}
      onMouseMove={actions.showControls}
    >
      <header
        className={[
          "pointer-events-none absolute inset-x-0 top-0 z-50 flex items-start justify-between px-2 pt-2 sm:px-3 sm:pt-3",
          "transition-all duration-200 ease-out",
          state.controlsVisible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
        ].join(" ")}
        onMouseEnter={actions.showControls}
        onMouseMove={actions.showControls}
        onFocus={actions.showControls}
      >
        <div className="pointer-events-auto flex min-w-0 items-center gap-1.5 rounded-xl border border-white/10 bg-neutral-950/55 px-1.5 py-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl">
          <button type="button" onClick={() => router.push("/")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40" title="Home" aria-label="Home">
            <HomeIcon className="h-[18px] w-[18px]" />
          </button>
          <div className="min-w-0 px-2 leading-tight">
            {isDivisional && parentEvent ? (
              <><div className="max-w-52 truncate text-xs font-bold text-white sm:max-w-72 sm:text-sm">{parentEvent.name}</div><div className="text-[9px] text-neutral-500 sm:text-[10px]"><EventLocalTime timezone={parentEvent.timezone} /></div></>
            ) : (
              <><div className="text-xs font-bold text-white sm:text-sm">FieldView</div><div className="text-[9px] text-neutral-500 sm:text-[10px]">Powered by The Blue Alliance</div></>
            )}
          </div>
        </div>
        <div className="pointer-events-auto rounded-xl border border-white/10 bg-neutral-950/55 p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl">
          <TileSurfaceSettingsView state={state} actions={actions} triggerClassName="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40" open={settingsOpen} onOpenChange={setSettingsOpen} />
        </div>
      </header>

      <TileView
        controller={tileSurfaceController}
        isDivisional={isDivisional}
      />
    </div>
  );
}
