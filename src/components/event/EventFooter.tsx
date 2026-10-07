"use client";

import type {
  TBAEliminationAlliance,
  TBAEventTeamStatuses,
} from "@/lib/tba/types";
import type { ReactNode } from "react";
import type { EventViewFooterMode } from "@/components/eventview/EventViewConfig";
import MatchStrip from "@/components/match/MatchStrip";
import RankingsStrip from "@/components/event/RankingsStrip";
import EventLocalTime from "@/components/event/EventLocalTime";

type EventFooterProps = {
  mode: EventViewFooterMode;
  eventName?: string | null;
  eventTimezone?: string | null;
  wssConnected?: boolean;
  wssStale?: boolean;
  multiviewHidden?: boolean;
  isDivisional?: boolean;
  teamPills?: ReactNode[];
  matches?: Parameters<typeof MatchStrip>[0]["matches"];
  team?: string[];
  nextMatch?: Parameters<typeof MatchStrip>[0]["nextMatch"];
  lastMatch?: Parameters<typeof MatchStrip>[0]["lastMatch"];
  playoffAlliances?: TBAEliminationAlliance[];
  playoffType?: number | null;
  teamsStatuses: TBAEventTeamStatuses;
  multiview?: Parameters<typeof MatchStrip>[0]["multiview"];
};

export default function EventFooter({
  mode,
  eventName,
  eventTimezone,
  wssConnected = false,
  wssStale = false,
  multiviewHidden = false,
  isDivisional = false,
  teamPills = [],
  matches = [],
  team = [],
  nextMatch,
  lastMatch,
  playoffAlliances = [],
  playoffType = null,
  teamsStatuses,
  multiview = {},
}: EventFooterProps) {
  const contentHidden = mode === "hidden" || multiviewHidden;

  return (
    <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
      <div className="relative">
        <div
          className={`pointer-events-auto absolute left-0 z-30 flex max-w-[calc(100%-0.5rem)] items-end gap-1 ${
            contentHidden ? "bottom-0 translate-y-0" : "bottom-full translate-y-[1px]"
          }`}
        >
          <div className="shrink-0 rounded-t-lg border-x border-t border-white/10 bg-neutral-950 px-2 py-1 shadow-lg">
            <div className="flex items-end gap-2 whitespace-nowrap leading-none">
              <span className="flex items-center gap-1.5 truncate text-[11px] font-bold text-white">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    !wssConnected
                      ? "bg-neutral-600"
                      : wssStale
                        ? "bg-blue-700"
                        : "bg-green-500"
                  }`}
                  title={
                    !wssConnected
                      ? "Live updates disconnected"
                      : wssStale
                        ? "WebSocket quiet; using TBA fallback polling"
                        : "Live updates connected"
                  }
                />
                <span className="truncate">{eventName || "Event"}</span>
                {eventTimezone && !isDivisional ? (
                  <span className="mt-0.5 text-[9px] text-neutral-500">
                    <EventLocalTime timezone={eventTimezone} />
                  </span>
                ) : null}
              </span>
            </div>
          </div>
          {teamPills.length > 0 ? (
            <div className="flex items-center gap-1">{teamPills}</div>
          ) : null}
        </div>

        <div
          className={`pointer-events-auto transition-transform duration-200 ${
            contentHidden ? "translate-y-full" : "translate-y-0"
          }`}
        >
          <div className={mode === "split" ? "grid grid-cols-2" : undefined}>
            {mode === "rankings" ? (
              <RankingsStrip
                teamsStatuses={teamsStatuses}
                playoffAlliances={playoffAlliances}
                playoffType={playoffType}
                trackedTeams={team}
              />
            ) : mode === "split" ? (
              <>
                <div className="min-w-0 border-r border-white/15">
                  <MatchStrip
                    matches={matches}
                    team={team}
                    nextMatch={nextMatch}
                    lastMatch={lastMatch}
                    eventTimezone={eventTimezone}
                    playoffAlliances={playoffAlliances}
                    playoffType={playoffType}
                    multiview={multiview}
                  />
                </div>
                <div className="min-w-0">
                  <RankingsStrip
                    teamsStatuses={teamsStatuses}
                    playoffAlliances={playoffAlliances}
                    playoffType={playoffType}
                    trackedTeams={team}
                  />
                </div>
              </>
            ) : (
              <MatchStrip
                matches={matches}
                team={team}
                nextMatch={nextMatch}
                lastMatch={lastMatch}
                eventTimezone={eventTimezone}
                playoffAlliances={playoffAlliances}
                playoffType={playoffType}
                multiview={multiview}
              />
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}