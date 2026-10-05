"use client";

import type { ReactNode } from "react";
import type { TBAEliminationAlliance, TBAEventTeamStatuses } from "@/lib/tba/types";
import type { EventViewFooterMode } from "./EventViewConfig";
import MatchStrip from "@/components/match/MatchStrip";
import RankingsStrip from "@/components/event/RankingsStrip";
import EventLocalTime from "@/components/event/EventLocalTime";

type EventFooterProps = {
  mode: EventViewFooterMode;
  eventName?: string | null;
  eventTimezone?: string | null;
  wssConnected?: boolean;
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
  const showContent = mode !== "hidden";

  return (
    <footer className="relative z-20 shrink-0 bg-neutral-950/95">
      <div className="absolute bottom-full left-0 z-10 -mb-px flex max-w-[calc(100%-0.5rem)] items-end gap-1">
        <div className="shrink-0 rounded-t-lg border-x border-t border-white/10 bg-neutral-950 px-2 py-0 shadow-lg">
          <div className="flex flex-col whitespace-nowrap leading-none translate-y-[5px]">
            <span className="flex items-center gap-1.5 truncate text-[11px] font-bold text-white">
              <span className="truncate">
                {eventName || "Event"}
              </span>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${wssConnected ? "bg-green-500" : "bg-neutral-600"}`}
                title={wssConnected ? "Live updates connected" : "Live updates disconnected"}
              />
            </span>
            {eventTimezone && !isDivisional ? (
              <span className="mt-0.5 text-[9px] text-neutral-500">
                <EventLocalTime timezone={eventTimezone} />
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {showContent ? (
        <div className={mode === "split" ? "grid grid-cols-2" : undefined}>
          {mode === "rankings" ? (
            <RankingsStrip
              teamsStatuses={teamsStatuses}
              playoffAlliances={playoffAlliances}
              playoffType={playoffType}
            />
          ) : mode === "split" ? (
            <>
              <div className="min-w-0 border-r border-white/15">
                <MatchStrip
                  matches={matches}
                  team={team}
                  nextMatch={nextMatch}
                  lastMatch={lastMatch}
                  playoffAlliances={playoffAlliances}
                  playoffType={playoffType}
                  teamPills={teamPills}
                  multiview={multiview}
                />
              </div>
              <div className="min-w-0">
                <RankingsStrip
                  teamsStatuses={teamsStatuses}
                  playoffAlliances={playoffAlliances}
                  playoffType={playoffType}
                />
              </div>
            </>
          ) : (
            <MatchStrip
              matches={matches}
              team={team}
              nextMatch={nextMatch}
              lastMatch={lastMatch}
              playoffAlliances={playoffAlliances}
              playoffType={playoffType}
              teamPills={teamPills}
              multiview={multiview}
            />
          )}
        </div>
      ) : null}
    </footer>
  );
}
