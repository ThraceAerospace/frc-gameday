"use client";

import { useEventState } from "@/lib/events";
import { useTrackedMatches } from "@/components/eventview/hooks/useTrackedMatches";
import { compactMatchLabel } from "@/lib/gameday/matchUtils";
import { matchLongName, matchShortName } from "@/lib/tba/formatters";
import type { TileSurfaceActions } from "@/components/surface/TileSurfaceActions";
import type { TileSurfaceState } from "@/components/surface/TileSurfaceState";
import type { TBAMatch } from "@/lib/tba/types";
import type { EventRealtimeStatus } from "@/lib/events/useEventState";
import NextMatchCountdown from "../match/NextMatchCountdown";

function teamNumber(teamKey: string) {
  return teamKey.replace(/^frc/, "");
}

type Props = {
  eventKey: string;
  position: number;
  state: TileSurfaceState;
  actions: TileSurfaceActions;
  realtimeStatus?: EventRealtimeStatus;
};

export default function RemoteEventCard({
  eventKey,
  position,
  state,
  actions,
  realtimeStatus,
}: Props) {
  const {
    event,
    matches,
    eventNextMatch,
  } = useEventState(eventKey);
  const websocketStatus = realtimeStatus?.websocketStatus;
  const websocketStale = realtimeStatus?.websocketStale ?? false;
  const trackedTeams = state.eventConfigs[eventKey]?.trackedTeams ?? [];
  const { trackedNextMatches } = useTrackedMatches(matches, trackedTeams);
  const selected = state.activeKey === eventKey;

  const match = eventNextMatch;
  const redTeams = match?.alliances.red.team_keys ?? [];
  const blueTeams = match?.alliances.blue.team_keys ?? [];

  const trackedNext = trackedTeams
    .map((team) => ({ team, match: trackedNextMatches[team] }))
    .filter(({ match: nextMatch }) => nextMatch)
    .sort((a, b) => {
      const aTime = a.match?.predicted_time ?? a.match?.time ?? Infinity;
      const bTime = b.match?.predicted_time ?? b.match?.time ?? Infinity;
      return aTime - bTime;
    });

  return (
    <button
      type="button"
      onClick={() => actions.toggleActive(eventKey)}
      className={`w-full rounded-2xl border p-4 text-left transition-colors active:scale-[0.99] ${
        selected
          ? "border-white/50 bg-white/[0.09] shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
          : "border-white/10 bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.055]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold">
            <span className="flex items-center gap-1.5">
              <span
                className={
                  "h-1.5 w-1.5 shrink-0 rounded-full " +
                  (websocketStatus === "connected"
                    ? websocketStale
                      ? "bg-blue-700"
                      : "bg-green-500"
                    : websocketStatus === "connecting"
                      ? "bg-yellow-500"
                      : "bg-neutral-600")
                }
                title={
                  websocketStatus === undefined
                    ? "Waiting for display live-update status"
                    : websocketStatus === "connected"
                    ? websocketStale
                      ? "WebSocket quiet; using TBA fallback polling"
                      : "Live updates connected"
                    : websocketStatus === "connecting"
                      ? "Connecting to live updates"
                      : "Live updates disconnected"
                }
              />
              <span className="truncate">
                {event?.name?.replace(" - FIRST Robotics Competition", "") ?? eventKey}
              </span>
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-neutral-500">{eventKey}</div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
            selected ? "bg-white text-black" : "bg-neutral-800 text-neutral-400"
          }`}
        >
          {selected ? "Focused" : `Event ${position + 1}`}
        </span>
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">
            Next Match
          </span>
          {match ? (
            <NextMatchCountdown nextMatch={match} />
          ) : null}
        </div>

        {match ? (
          <>
            <div className="mt-1 text-xl font-bold tracking-tight">
              {matchLongName(match, event?.playoff_type ?? null)}
            </div>
            <div className="mt-3 space-y-2">
              {[{ name: "Red", teams: redTeams }, { name: "Blue", teams: blueTeams }].map(
                ({ name, teams }) => (
                  <div key={name} className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`w-9 text-[10px] font-bold uppercase ${name === "Red" ? "text-red-400" : "text-blue-400"}`}
                    >
                      {name}
                    </span>
                    {teams.map((team) => (
                      <span
                        key={team}
                        className={`rounded-full border px-2.5 py-1 text-xs ${
                          name === "Red"
                            ? "border-red-800 bg-red-950 text-red-200"
                            : "border-blue-800 bg-blue-950 text-blue-200"
                        } ${trackedTeams.includes(team) ? "font-bold ring-1 ring-white/70" : "font-semibold"}`}
                      >
                        {teamNumber(team)}
                      </span>
                    ))}
                  </div>
                ),
              )}
            </div>
          </>
        ) : (
          <div className="mt-2 text-sm text-neutral-500">No upcoming match</div>
        )}
      </div>

      <div className="mt-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">
          Tracked Teams
        </div>
        {trackedTeams.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {trackedTeams.map((team) => {
              const next = trackedNext.find((item) => item.team === team)?.match;
              return (
                <span
                  key={team}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-neutral-900 px-2.5 py-1 text-xs font-semibold text-neutral-200"
                >
                  {teamNumber(team)}
                  {next ? (
                    <span className="text-[10px] font-normal text-neutral-500">
                      {compactMatchLabel(next)}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        ) : (
          <div className="mt-2 text-xs text-neutral-600">No tracked teams</div>
        )}
      </div>
    </button>
  );
}
