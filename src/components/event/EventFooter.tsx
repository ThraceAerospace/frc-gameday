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
import StatboticsPredictionStrip from "@/components/match/StatboticsPredictionStrip";

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
  priorityEditing?: boolean;
  activeHighlighted?: boolean;
  imminentMatch?: boolean;
  onToggleActive?: () => void;
  slotNumber?: number;
  controlHeld?: boolean;
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
  priorityEditing = false,
  activeHighlighted = false,
  imminentMatch = false,
  onToggleActive,
  slotNumber,
  controlHeld = false,
}: EventFooterProps) {
  const contentHidden = mode === "hidden" || multiviewHidden;

  return (
    <footer
      className={`pointer-events-none z-20 w-full ${
        contentHidden
          ? "absolute inset-x-0 bottom-0"
          : "relative shrink-0"
      }`}
    >
      <div className={`relative ${contentHidden ? "h-0" : ""}`}>
        <div
          className={`pointer-events-auto absolute z-30 flex max-w-[calc(100%-0.5rem)] items-end gap-1 ${
            contentHidden
              ? "bottom-0 left-0 translate-y-[2px]"
              : "bottom-full left-0 translate-y-[2px]"
          }`}
        >
          <button
            type="button"
            onClick={onToggleActive}
            disabled={!onToggleActive}
            className={`relative z-30 box-border flex h-6 shrink-0 items-end pb-0 pt-px rounded-t-lg border-x border-t ${priorityEditing ? "border-blue-500/90 shadow-[0_0_12px_rgba(59,130,246,0.12)]" : imminentMatch ? "!border-[var(--tracked-accent)] tracked-accent-pill-glow" : activeHighlighted ? "border-white shadow-[0_0_12px_rgba(255,255,255,0.12)]" : "border-white/10"} bg-neutral-950 px-2 shadow-lg ${
              onToggleActive
                ? "cursor-pointer transition-colors hover:border-white/25 hover:bg-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                : "cursor-default"
            }`}
            aria-label={onToggleActive ? `Activate ${eventName || "event"}` : undefined}
          >
            <span className="flex items-center gap-1.5 whitespace-nowrap leading-none text-[11px] font-bold text-white">
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
              {controlHeld && slotNumber ? (
                <span className="shrink-0 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[9px] font-mono font-semibold text-neutral-300">
                  {slotNumber}
                </span>
              ) : null}
              <span className="truncate">{eventName || "Event"}</span>
                  {eventTimezone && !isDivisional ? (
                    <span className="text-[9px] leading-none text-neutral-500">
                      <EventLocalTime timezone={eventTimezone} />
                    </span>
              ) : null}
            </span>
          </button>
          {teamPills.length > 0 ? (
            <div className="flex items-center gap-1">{teamPills}</div>
          ) : null}
        </div>

        <div
          className={`pointer-events-auto border-x border-t ${priorityEditing ? "border-blue-500/80" : imminentMatch ? "!border-[var(--tracked-accent)] tracked-accent-pill-glow" : activeHighlighted ? "border-white shadow-[0_-1px_0_rgba(255,255,255,0.35)]" : "border-white/10"} ${
            contentHidden
              ? "absolute inset-x-0 bottom-0 translate-y-full"
              : "relative translate-y-0"
          } transition-transform duration-200`}
        >
          <div className={mode === "split" || mode === "statbotics" ? "grid grid-cols-2" : undefined}>
            {mode === "statbotics" ? (
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
                  <StatboticsPredictionStrip match={nextMatch ?? lastMatch ?? null} />
                </div>
              </>
            ) : mode === "rankings" ? (
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