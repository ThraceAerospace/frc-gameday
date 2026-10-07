"use client";

import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowPathIcon,
  ArrowUturnRightIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  ArrowUpIcon,
  Squares2X2Icon,
  UserGroupIcon,
  VideoCameraIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { LAYOUTS, pickLayout } from "@/lib/multiview/layouts";
import type { TileSurfaceActions } from "./TileSurfaceActions";
import type { TileSurfaceState } from "./TileSurfaceState";
import type { EventViewFooterMode } from "@/components/eventview/EventViewConfig";
import { buildStreams, type BuiltStream } from "@/lib/gameday/buildStreams";
import { useEventState } from "@/lib/events";
import StreamModal from "@/components/eventview/StreamModal";
import TeamModal from "@/components/team/TeamModal";

type TileSurfaceSettingsViewProps = {
  state: TileSurfaceState;
  actions: TileSurfaceActions;
  triggerClassName?: string;
  triggerTitle?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

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
  state: TileSurfaceState;
  actions: TileSurfaceActions;
}) {
  const { event, teams, teamsStatuses } = useEventState(eventKey);
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
  const configuredLabel = label.replace(" - FIRST Robotics Competition", "");
  const eventName = event?.name?.replace(" - FIRST Robotics Competition", "");
  const displayLabel =
    !configuredLabel || /^Stream \d+$/.test(configuredLabel)
      ? eventName ?? eventKey
      : configuredLabel;

  const streamOptions = streams.map((stream) => ({
    ...stream,
    key: `${stream.type}:${stream.channel}:${stream.date ?? ""}`,
  }));

  const toggleTeam = (team: string) => {
    const next = trackedTeams.includes(team)
      ? trackedTeams.filter((value) => value !== team)
      : [...trackedTeams, team];

    actions.setEventViewTrackedTeams(eventKey, next);
  };

  return (
    <div className="rounded-xl border border-white/10 bg-neutral-950/60 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md sm:p-4">
      <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {displayLabel}
          </div>
          <div className="mt-1 text-[11px] text-neutral-500">{eventKey}</div>
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:flex xl:shrink-0">
          <label className="flex min-w-0 items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-500 xl:w-auto xl:border-0 xl:bg-transparent xl:px-0 xl:py-0">
            <span className="truncate">Bottom Bar</span>
            <select
              value={config?.footerMode ?? "matchStrip"}
              onChange={(event) =>
                actions.setEventViewConfig(eventKey, {
                  footerMode: event.target.value as EventViewFooterMode,
                })
              }
              className="min-w-0 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 outline-none hover:border-neutral-700"
              aria-label="Footer mode"
            >
              <option value="matchStrip">Matches</option>
              <option value="rankings">Rankings</option>
              <option value="split">Matches + Rankings</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>

          <button className="icon-button" title="Track teams" aria-label="Track teams" onClick={() => setTeamsOpen(true)}>
            <UserGroupIcon />
          </button>
          <button className="icon-button" title="Refresh live data" aria-label="Refresh live data" onClick={() => actions.runEventViewCommand(eventKey, "refresh")}>
            <ArrowPathIcon />
          </button>
          <button className="icon-button" title="Choose webcast" aria-label="Choose webcast" onClick={() => setStreamsOpen(true)}>
            <VideoCameraIcon />
          </button>
          <button
            className="icon-button"
            title={config?.streamMuted ? "Unmute webcast" : "Mute webcast"}
            aria-label={config?.streamMuted ? "Unmute webcast" : "Mute webcast"}
            onClick={() =>
              actions.setEventViewConfig(eventKey, {
                streamMuted: !(config?.streamMuted ?? true),
              })
            }
          >
            {config?.streamMuted ? <SpeakerXMarkIcon /> : <SpeakerWaveIcon />}
          </button>
          <label className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 text-xs text-neutral-500 xl:border-0 xl:bg-transparent">
            <span className="sr-only">Webcast volume</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={config?.streamVolume ?? 100}
              onChange={(event) =>
                actions.setEventViewConfig(eventKey, {
                  streamVolume: Number(event.target.value),
                })
              }
              className="w-20"
              aria-label="Webcast volume"
            />
            <span className="w-8 text-right text-[10px] tabular-nums text-neutral-500">
              {config?.streamVolume ?? 100}%
            </span>
          </label>
          <button
            className="icon-button"
            title="Reload webcast"
            aria-label="Reload webcast"
            onClick={() => actions.runEventViewCommand(eventKey, "reloadStream")}
          >
            <ArrowUturnRightIcon />
          </button>
          <button onClick={() => actions.movePriority(position, -1)} disabled={position === 0} className="icon-button disabled:opacity-30" title="Move up" aria-label="Move up">
            <ArrowUpIcon />
          </button>
          <button onClick={() => actions.movePriority(position, 1)} disabled={position === state.priority.length - 1} className="icon-button disabled:opacity-30" title="Move down" aria-label="Move down">
            <ArrowDownIcon />
          </button>
          <button onClick={() => actions.removeEvent(eventKey)} className="icon-button" title="Remove event" aria-label="Remove event">
            <XMarkIcon />
          </button>
        </div>
      </div>

      <div className="mt-3 border-t border-neutral-800 pt-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-600">
          Tracked Teams
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <label className="mr-1 flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900 px-2 py-1 text-[10px] text-neutral-400">
            <input
              type="checkbox"
              checked={config?.matchImminence ?? false}
              onChange={(event) =>
                actions.setEventViewConfig(eventKey, {
                  matchImminence: event.target.checked,
                })
              }
              className="h-3 w-3"
              aria-label="Highlight imminent match"
              title="Highlight this event when its next match is also a tracked team's next match"
            />
            <span>Imminent</span>
          </label>
          {trackedTeams.length > 0 ? (
            trackedTeams.map((team) => (
              <span key={team} className="rounded-full bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-300">
                {team}
              </span>
            ))
          ) : (
            <span className="text-[11px] text-neutral-600">No tracked teams</span>
          )}
        </div>
      </div>

      {typeof document !== "undefined"
        ? createPortal(
            <StreamModal
              open={streamsOpen}
              onClose={() => setStreamsOpen(false)}
              streams={streamOptions}
              activeKey={config?.selectedStream ?? null}
              onSelect={(key) => {
                actions.setEventViewStream(eventKey, key);
                setStreamsOpen(false);
              }}
            />,
            document.body,
          )
        : null}

      {typeof document !== "undefined"
        ? createPortal(
            <TeamModal
              open={teamsOpen}
              onClose={() => setTeamsOpen(false)}
              teams={teams}
              teamsStatuses={teamsStatuses}
              trackedTeams={trackedTeams}
              onToggle={toggleTeam}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

export default function TileSurfaceSettingsView({
  state,
  actions,
  triggerClassName = "h-[30px] w-[30px] rounded hover:bg-stone-800",
  triggerTitle = "Multiview settings",
  open: controlledOpen,
  onOpenChange,
}: TileSurfaceSettingsViewProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;

  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) {
      setUncontrolledOpen(next);
    }
    onOpenChange?.(next);
  };
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const autoLayoutKey = pickLayout(state.streams.length || 1);
  const selectedLayoutKey = state.highlightLayoutKey ?? state.layoutKey ?? autoLayoutKey;

  const filteredEvents = useMemo(() => {
    const query = state.eventSearch.trim().toLowerCase();

    return state.availableEvents
      .filter((event) => !state.streams.includes(String(event.key)))
      .filter(
        (event) =>
          !query ||
          [event.name, event.short_name, event.key, event.city, event.state_prov, event.country]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query)),
      );
  }, [state.availableEvents, state.eventSearch, state.streams]);

  const closeSettings = () => {
    setOpen(false);
    actions.closeEventPicker();
  };

  const panel = (
    <div className="fixed inset-0 z-[100] flex h-screen w-screen flex-col overflow-hidden bg-black/60 text-white backdrop-blur-xl">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-neutral-950/80 px-4 py-3 backdrop-blur-md sm:px-6 sm:py-4">
        <div className="min-w-0">
          <div className="text-base font-semibold sm:text-lg">Multiview Settings</div>
          <div className="mt-0.5 hidden text-xs text-neutral-500 sm:block">
            Configure the Multiview Controller
          </div>
        </div>
        <button
          onClick={closeSettings}
          className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-white"
          title="Close settings"
        >
          <XMarkIcon className="h-5 w-5" />
          <span className="hidden sm:inline">Close</span>
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5 lg:p-6">
        <div className="mx-auto grid w-full h-full grid-cols-1 gap-4 xl:grid-cols-12 xl:gap-5">
          <section className="flex min-h-0 flex-col rounded-xl border border-white/10 bg-neutral-900/65 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] xl:col-span-3 xl:max-h-[calc(100vh-132px)]">
            <div className="mb-3">
              <h2 className="text-sm font-semibold">Layout</h2>
              <p className="mt-1 text-xs leading-5 text-neutral-500">Choose how event views are arranged on screen.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 xl:grid-cols-1">
              <button
                onClick={actions.resetLayout}
                className={`rounded-lg px-3 py-3 text-left text-sm ${state.layoutKey === null ? "bg-green-700" : "bg-neutral-950 hover:bg-neutral-800"}`}
              >
                <div className="font-semibold">Auto Layout</div>
                <div className="mt-1 text-xs text-neutral-300">{LAYOUTS[autoLayoutKey].name}</div>
              </button>
              {Object.entries(LAYOUTS).map(([key, value]) => (
                <button
                  key={key}
                  onClick={() => actions.setLayout(key as keyof typeof LAYOUTS)}
                  className={`rounded-lg px-3 py-3 text-left text-sm ${selectedLayoutKey === key ? "bg-neutral-700" : "bg-neutral-950 hover:bg-neutral-800"}`}
                >
                  {value.name}
                </button>
              ))}
            </div>
          </section>

          <section className="flex min-h-0 flex-col rounded-xl border border-white/10 bg-neutral-900/65 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] xl:col-span-6 xl:max-h-[calc(100vh-132px)]">
            <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Events</h2>
                <p className="mt-1 text-xs leading-5 text-neutral-500">Manage the events displayed by this Multiview.</p>
              </div>
              <button onClick={actions.openEventPicker} className="shrink-0 rounded-lg bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-700">
                Add Event
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="space-y-2">
                {state.priority.map((eventKey, position) => (
                  <EventSettingsRow
                    key={eventKey}
                    eventKey={eventKey}
                    label={state.labels[eventKey] ?? `Stream ${position + 1}`}
                    position={position}
                    state={state}
                    actions={actions}
                  />
                ))}
                {state.priority.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
                    No events configured.
                  </div>
                ) : null}
              </div>
            </div>
          </section>


        </div>
      </main>

      {state.eventPickerOpen
        ? createPortal(
            <div
              className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-4"
              onClick={actions.closeEventPicker}
            >
              <div
                className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-900/95 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
                  <div className="font-bold">Add Event</div>
                  <button onClick={actions.closeEventPicker} className="icon-button" title="Close" aria-label="Close">
                    <XMarkIcon />
                  </button>
                </div>
                <div className="border-b border-neutral-800 p-3">
                  <input
                    autoFocus
                    type="text"
                    value={state.eventSearch}
                    onChange={(event) => actions.setEventSearch(event.target.value)}
                    placeholder="Search events..."
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm outline-none focus:border-neutral-500"
                  />
                </div>
                <div className="min-h-0 overflow-y-auto p-2">
                  {state.eventsLoading ? (
                    <div className="p-6 text-center text-sm text-neutral-500">Loading events...</div>
                  ) : filteredEvents.length === 0 ? (
                    <div className="p-6 text-center text-sm text-neutral-500">No matching events.</div>
                  ) : (
                    <div className="space-y-1">
                      {filteredEvents.map((event) => (
                        <button
                          key={event.key}
                          onClick={() => {
                            actions.addEvent(event);
                            actions.closeEventPicker();
                          }}
                          className="w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-neutral-800"
                        >
                          <div className="truncate text-sm font-semibold">{event.name ?? event.short_name ?? event.key}</div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-neutral-500">
                            <span>{event.key}</span>
                            {event.city ? <span>{event.city}{event.state_prov ? `, ${event.state_prov}` : ""}</span> : null}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={triggerClassName}
        title={triggerTitle}
        aria-label={triggerTitle}
      >
        <Squares2X2Icon className="h-[17px] w-[17px] justify-self-center" />
      </button>

      {mounted && open ? createPortal(panel, document.body) : null}
    </>
  );
}
