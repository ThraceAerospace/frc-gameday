"use client";

import { useState, useSyncExternalStore } from "react";
import { SignalIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import type { RemotePeerStatus } from "@/lib/remote/webrtc";
import type { TileSurfaceController } from "@/components/surface/TileSurfaceActions";
import TileSurfaceSettingsView from "@/components/surface/TileSurfaceSettingsView";
import RemoteEventCard from "./RemoteEventCard";
import type { EventStateSnapshot } from "@/lib/events/EventState";
import { useTileSurfaceKeyboard } from "@/components/surface/TileSurfaceController";

type Props = {
  controller: TileSurfaceController;
  peerStatus: RemotePeerStatus;
  eventStates: Record<string, EventStateSnapshot>;
};

export default function RemoteSurface({
  controller,
  peerStatus,
  eventStates,
}: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useTileSurfaceKeyboard(state, controller.actions, () => setSettingsOpen((open) => !open));

  return (
    <main className="min-h-screen bg-black text-white">
      <TileSurfaceSettingsView
        state={state}
        actions={controller.actions}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        triggerClassName="hidden"
      />

      <header className="sticky top-0 z-40 border-b border-white/10 bg-black/90 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-semibold">FieldView Remote</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-neutral-500">
              <SignalIcon className={`h-3.5 w-3.5 ${peerStatus === "connected" ? "text-green-400" : "text-yellow-400"}`} />
              {peerStatus === "connected" ? "Connected" : "Connecting…"}
            </div>
          </div>
          <div className="shrink-0">
            <button className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm font-medium text-white/80 hover:border-white/20 hover:bg-white/[0.04]" onClick={() => setSettingsOpen(true)}>
              <Cog6ToothIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-6">
        {state.priority.length === 0 ? (
          <button
            type="button"
            onClick={controller.actions.openEventPicker}
            className="flex min-h-48 w-full flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center hover:border-white/20 hover:bg-white/[0.04]"
          >
            <Cog6ToothIcon className="h-7 w-7 text-neutral-600" />
            <div className="mt-3 text-sm font-semibold text-neutral-400">No events configured</div>
            <div className="mt-1 text-xs text-neutral-600">Open settings to add an event.</div>
          </button>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {state.priority.map((tileId, position) => {
              const eventKey = state.tileEvents[tileId] ?? tileId;
              const eventState = eventStates[eventKey];

              return (
                <RemoteEventCard
                  key={tileId}
                  eventKey={eventKey}
                  position={position}
                  state={state}
                  actions={controller.actions}
                  eventState={eventState}
                />
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
