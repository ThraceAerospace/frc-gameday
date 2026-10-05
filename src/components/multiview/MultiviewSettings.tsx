"use client";

import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownIcon, ArrowPathIcon, ArrowUpIcon, ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  UserGroupIcon, VideoCameraIcon, XMarkIcon,
} from "@heroicons/react/24/outline";
import { LAYOUTS, pickLayout } from "@/lib/multiview/layouts";
import type { MultiviewActions } from "./MultiviewActions";
import type { MultiviewState } from "./MultiviewState";
import { buildStreams, type BuiltStream } from "@/lib/gameday/buildStreams";
import { useEvent } from "@/components/eventview/hooks/useEvent";
import { useTeams } from "@/components/eventview/hooks/useTeams";
import { useTeamsStatuses } from "@/components/eventview/hooks/useTeamsStatuses";
import StreamModal from "@/components/eventview/StreamModal";
import TeamModal from "@/components/eventview/team/TeamModal";


type MultiviewSettingsProps = { state: MultiviewState; actions: MultiviewActions; };

function EventSettingsRow({
  eventKey,
  label,
  position,
  state,
  actions,
}: {
  eventKey: string;
  label: string;
  position: number;
  state: MultiviewState;
  actions: MultiviewActions;
}) {
  const { event } = useEvent(eventKey);
  const { teams } = useTeams(eventKey);
  const { teamsStatuses } = useTeamsStatuses(eventKey);
  const [streams, setStreams] = useState<BuiltStream[]>([]);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [streamsOpen, setStreamsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!event?.webcasts) {
      setStreams([]);
      return;
    }

    buildStreams(event.webcasts).then((builtStreams) => {
      if (!cancelled) setStreams(builtStreams);
    });

    return () => {
      cancelled = true;
    };
  }, [event?.webcasts]);

  const config = state.eventConfigs[eventKey];
  const trackedTeams = config?.trackedTeams ?? [];

  const toggleTeam = (team: string) => {
    const next = trackedTeams.includes(team)
      ? trackedTeams.filter((value) => value !== team)
      : [...trackedTeams, team];

    actions.setEventViewTrackedTeams(eventKey, next);
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {label.replace(" - FIRST Robotics Competition", "")}
          </div>
          <div className="mt-1 text-[11px] text-neutral-500">{eventKey}</div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button onClick={() => actions.movePriority(position, -1)} disabled={position === 0} className="icon-button disabled:opacity-30" title="Move up" aria-label="Move up"><ArrowUpIcon /></button>
          <button onClick={() => actions.movePriority(position, 1)} disabled={position === state.priority.length - 1} className="icon-button disabled:opacity-30" title="Move down" aria-label="Move down"><ArrowDownIcon /></button>
          <button onClick={() => actions.removeEvent(eventKey)} className="icon-button shrink-0" title="Remove event" aria-label="Remove event"><XMarkIcon /></button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-neutral-800 pt-3">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {trackedTeams.length > 0 ? (
            trackedTeams.map((team) => (
              <span key={team} className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300">
                {team}
              </span>
            ))
          ) : (
            <span className="text-[11px] text-neutral-600">No tracked teams</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button className="icon-button" title="Track teams" aria-label="Track teams" onClick={() => setTeamsOpen(true)}><UserGroupIcon /></button>
          <button className="icon-button" title="Choose webcast" aria-label="Choose webcast" onClick={() => setStreamsOpen(true)}><VideoCameraIcon /></button>
          <button className={"icon-button " + (config?.chatOpen ? "active" : "")} title={config?.chatOpen ? "Close chat" : "Open chat"} aria-label={config?.chatOpen ? "Close chat" : "Open chat"} onClick={() => actions.setEventViewChat(eventKey, !config?.chatOpen)}><ChatBubbleLeftRightIcon /></button>
          <button className="icon-button" title="Refresh live data" aria-label="Refresh live data" onClick={() => actions.runEventViewCommand(eventKey, "refresh")}><ArrowPathIcon /></button>
        </div>
      </div>

      <StreamModal
        open={streamsOpen}
        onClose={() => setStreamsOpen(false)}
        streams={streams}
        activeKey={config?.selectedStream ?? null}
        onSelect={(key) => {
          actions.setEventViewStream(eventKey, key);
          setStreamsOpen(false);
        }}
      />

      <TeamModal
        open={teamsOpen}
        onClose={() => setTeamsOpen(false)}
        teams={teams}
        teamsStatuses={teamsStatuses}
        trackedTeams={trackedTeams}
        onToggle={toggleTeam}
      />
    </div>
  );
}


export default function MultiviewSettings({ state, actions }: MultiviewSettingsProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const autoLayoutKey = pickLayout(state.streams.length || 1);
  const selectedLayoutKey = state.highlightLayoutKey ?? state.layoutKey ?? autoLayoutKey;

  const filteredEvents = useMemo(() => {
    const query = state.eventSearch.trim().toLowerCase();
    return state.availableEvents
      .filter((event) => !state.streams.includes(String(event.key)))
      .filter((event) => !query || [event.name, event.short_name, event.key, event.city, event.state_prov, event.country]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(query)));
  }, [state.availableEvents, state.eventSearch, state.streams]);

  const closeSettings = () => { setOpen(false); actions.closeEventPicker(); };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-[30px] w-[30px] rounded hover:bg-stone-800"
        title="Multiview settings"
        aria-label="Multiview settings"
      >
        <Cog6ToothIcon className="mx-auto h-[17px] w-[17px]" />
      </button>

      {mounted && open ? createPortal(
        <div className="fixed inset-0 z-[100] flex h-screen w-screen flex-col bg-neutral-950 text-white">
          <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-950 px-6 py-4">
            <div><div className="text-lg font-semibold">Multiview Settings</div><div className="mt-0.5 text-xs text-neutral-500">Configure the Multiview Controller</div></div>
            <button onClick={closeSettings} className="flex items-center gap-2 rounded px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-white" title="Close settings"><XMarkIcon className="h-5 w-5" />Close</button>
          </header>
          <main className="min-h-0 flex-1 p-6">
            <div className="mx-auto grid h-full w-full max-w-7xl grid-cols-1 gap-6 lg:grid-cols-[minmax(220px,0.85fr)_minmax(460px,2fr)_minmax(260px,1fr)]">
              <section className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="mb-4"><h2 className="text-sm font-semibold">Layout</h2><p className="mt-1 text-xs text-neutral-500">Choose how event views are arranged on screen.</p></div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                  <button onClick={actions.resetLayout} className={"w-full rounded px-3 py-3 text-left text-sm " + (state.layoutKey === null ? "bg-green-700" : "bg-neutral-950 hover:bg-neutral-800")}><div className="font-semibold">Auto Layout</div><div className="mt-1 text-xs text-neutral-500">{LAYOUTS[autoLayoutKey].name}</div></button>
                  {Object.entries(LAYOUTS).map(([key, value]) => <button key={key} onClick={() => actions.setLayout(key as keyof typeof LAYOUTS)} className={"w-full rounded px-3 py-3 text-left text-sm " + (selectedLayoutKey === key ? "bg-neutral-700" : "bg-neutral-950 hover:bg-neutral-800")}>{value.name}</button>)}
                </div>
              </section>

              <section className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="mb-4 flex shrink-0 items-start justify-between gap-4"><div><h2 className="text-sm font-semibold">Events</h2><p className="mt-1 text-xs text-neutral-500">Manage the events displayed by this Multiview.</p></div><button onClick={actions.openEventPicker} className="shrink-0 rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-700">Add Event</button></div>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1"><div className="space-y-2">
                  {state.priority.map((eventKey, position) => (
                    <EventSettingsRow
                      key={eventKey}
                      eventKey={eventKey}
                      label={state.labels[eventKey] ?? "Stream " + (position + 1)}
                      position={position}
                      state={state}
                      actions={actions}
                    />
                  ))}
                  {state.priority.length === 0 ? <div className="rounded-lg border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">No events configured.</div> : null}
                </div></div>
              </section>

              <section className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                <div className="mb-4"><h2 className="text-sm font-semibold">Behavior</h2><p className="mt-1 text-xs text-neutral-500">Configure automatic Multiview behavior.</p></div>
                <div className="space-y-3"><label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 p-3"><div className="min-w-0"><div className="text-xs font-semibold text-white">Focus imminent matches</div><div className="mt-1 text-[10px] leading-4 text-neutral-500">Automatically highlight an event when a tracked team&apos;s match is approaching.</div></div><input type="checkbox" checked={state.autoFocusMatches} onChange={(event) => actions.setAutoFocusMatches(event.target.checked)} className="h-4 w-4 shrink-0" /></label></div>
              </section>
            </div>
          </main>
          {state.eventPickerOpen ? <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4" onClick={actions.closeEventPicker}>
            <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3"><div className="font-bold">Add Event</div><button onClick={actions.closeEventPicker} className="icon-button" title="Close" aria-label="Close"><XMarkIcon /></button></div>
              <div className="border-b border-neutral-800 p-3"><input autoFocus type="text" value={state.eventSearch} onChange={(event) => actions.setEventSearch(event.target.value)} placeholder="Search events..." className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500" /></div>
              <div className="min-h-0 overflow-y-auto p-2">{state.eventsLoading ? <div className="p-6 text-center text-sm text-neutral-500">Loading events...</div> : filteredEvents.length === 0 ? <div className="p-6 text-center text-sm text-neutral-500">No matching events.</div> : <div className="space-y-1">{filteredEvents.map((event) => <button key={event.key} onClick={() => actions.addEvent(event)} className="w-full rounded px-3 py-2 text-left transition-colors hover:bg-neutral-800"><div className="truncate text-sm font-semibold">{event.name ?? event.short_name ?? event.key}</div><div className="mt-0.5 flex gap-2 text-xs text-neutral-500"><span>{event.key}</span>{event.city ? <span>{event.city}{event.state_prov ? ", " + event.state_prov : ""}</span> : null}</div></button>)}</div>}</div>
            </div>
          </div> : null}
        </div>, document.body) : null}
    </>
  );
}