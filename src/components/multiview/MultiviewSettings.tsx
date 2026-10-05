"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { LAYOUTS, pickLayout } from "@/lib/multiview/layouts";
import type { MultiviewActions } from "./MultiviewActions";
import type { MultiviewState } from "./MultiviewState";

type MultiviewSettingsProps = {
  state: MultiviewState;
  actions: MultiviewActions;
  trigger?: ReactNode;
};

export default function MultiviewSettings({ state, actions, trigger }: MultiviewSettingsProps) {
  const [open, setOpen] = useState(false);
  const [eventPickerOpen, setEventPickerOpen] = useState(false);
  const [eventSearch, setEventSearch] = useState("");

  const autoLayoutKey = pickLayout(state.streams.length || 1);
  const selectedLayoutKey = state.highlightLayoutKey ?? state.layoutKey ?? autoLayoutKey;

  const filteredEvents = useMemo(() => {
    const query = eventSearch.trim().toLowerCase();
    return state.availableEvents
      .filter((event) => !state.streams.includes(String(event.key)))
      .filter((event) => {
        if (!query) return true;
        return [event.name, event.short_name, event.key, event.city, event.state_prov, event.country]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      });
  }, [state.availableEvents, eventSearch, state.streams]);

  return (
    <>
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : null}
      <div
        onClick={() => setOpen(false)}
        className={"fixed inset-0 z-40 bg-black/50 transition-opacity " +
          (open ? "opacity-100" : "pointer-events-none opacity-0")}
      />

      <aside
        className={"fixed right-0 top-0 z-50 flex h-full w-[clamp(280px,25vw,400px)] flex-col border-l border-neutral-700 bg-neutral-900 p-3 shadow-xl transition-transform " +
          (open ? "translate-x-0" : "translate-x-full")}
      >
        <div className="mb-3 flex shrink-0 items-center justify-between font-bold">
          <span>Multiview Settings</span>
          <button onClick={() => setOpen(false)} className="icon-button" title="Close settings" aria-label="Close settings"><XMarkIcon /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <button onClick={() => setEventPickerOpen(true)} className="mb-4 w-full rounded bg-neutral-800 px-3 py-2 text-left text-sm hover:bg-neutral-700">Add Event</button>
          <div className="mb-4 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white">Focus imminent matches</div>
                <div className="mt-1 text-[10px] leading-4 text-neutral-500">Automatically highlight an event when a tracked team&apos;s match is approaching.</div>
              </div>
              <input type="checkbox" checked={state.autoFocusMatches} onChange={(event) => actions.setAutoFocusMatches(event.target.checked)} className="h-4 w-4 shrink-0" />
            </label>
          </div>

          <div className="mb-4 space-y-1">
            {state.priority.map((eventKey, position) => (
              <div key={eventKey} className="flex items-center justify-between rounded bg-neutral-800 px-2 py-1">
                <span className="truncate text-xs">{state.labels[eventKey] ?? "Stream " + (position + 1)}</span>
                <div className="flex gap-1">
                  <button onClick={() => actions.movePriority(position, -1)} className="icon-button" title="Move up"><ArrowUpIcon /></button>
                  <button onClick={() => actions.movePriority(position, 1)} className="icon-button" title="Move down"><ArrowDownIcon /></button>
                  <button type="button" onClick={() => actions.removeEvent(eventKey)} className="icon-button shrink-0" title={"Remove " + (state.labels[eventKey] ?? eventKey)} aria-label={"Remove " + (state.labels[eventKey] ?? eventKey)}><XMarkIcon /></button>
                </div>
              </div>
            ))}
          </div>

          <div className="mb-1 font-bold">Layouts</div>
          <button onClick={actions.resetLayout} className={"mt-2 block w-full rounded px-2 py-1 text-left text-sm " + (state.layoutKey === null ? "bg-green-700" : "hover:bg-neutral-800")}>Auto Layout ({LAYOUTS[autoLayoutKey].name})</button>
          {Object.entries(LAYOUTS).map(([key, value]) => (
            <button key={key} onClick={() => actions.setLayout(key as keyof typeof LAYOUTS)} className={"block w-full rounded px-2 py-1 text-left text-sm " + (selectedLayoutKey === key ? "bg-neutral-700" : "hover:bg-neutral-800")}>{value.name}</button>
          ))}
        </div>
      </aside>

      {eventPickerOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={() => setEventPickerOpen(false)}>
          <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <div className="font-bold">Add Event</div>
              <button onClick={actions.closeEventPicker} className="icon-button" title="Close"><XMarkIcon /></button>
            </div>
            <div className="border-b border-neutral-800 p-3">
              <input autoFocus type="text" value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} placeholder="Search events..." className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500" />
            </div>
            <div className="min-h-0 overflow-y-auto p-2">
              {state.eventsLoading ? <div className="p-6 text-center text-sm text-neutral-500">Loading events...</div> : filteredEvents.length === 0 ? <div className="p-6 text-center text-sm text-neutral-500">No matching events.</div> : (
                <div className="space-y-1">
                  {filteredEvents.map((event) => (
                    <button key={event.key} onClick={() => { actions.addEvent(event); setEventPickerOpen(false); }} className="w-full rounded px-3 py-2 text-left transition-colors hover:bg-neutral-800">
                      <div className="truncate text-sm font-semibold">{event.name ?? event.short_name ?? event.key}</div>
                      <div className="mt-0.5 flex gap-2 text-xs text-neutral-500"><span>{event.key}</span>{event.city && <span>{event.city}{event.state_prov ? ", " + event.state_prov : ""}</span>}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}