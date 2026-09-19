"use client";

import MatchCard from "./MatchCard";
import EventLocalTime from "./EventLocalTime";

export default function MatchStrip({
  matches = [],
  team = [],
  nextMatch = null,
  lastMatch = null,
  eventTimezone,
  playoffAlliances = [],
  playoffType = null,
  eventName,
  wssConnected = false,
  teamPills = [],
  showEventInfo = true,
  isDivisional = false,
  multiview = {},
}) {
  const seen = new Set();
  const cards = [];

  for (const match of [
    lastMatch,
    nextMatch,
    ...matches,
  ]) {
    if (
      !match?.key ||
      seen.has(match.key)
    ) {
      continue;
    }

    seen.add(match.key);
    cards.push(match);
  }

  const presentation =
    multiview?.presentation ?? {};

  /*
   * `matchInfo` controls only the match-card
   * strip. The event header remains visible
   * independently.
   */
  const hideMatchCards =
    presentation.matchInfo === "hidden";

  return (
    <div className="relative border-t border-l border-white/10 bg-neutral-950/95">
      {(showEventInfo ||
        teamPills.length > 0) && (
        <div className="absolute bottom-full left-0 z-10 -mb-px flex max-w-[calc(100%-0.5rem)] items-end gap-1">
          {showEventInfo && (
            <div className="shrink-0 rounded-t-lg border-x border-t border-white/10 bg-neutral-950 px-2 py-0 shadow-lg">
              <div className="flex translate-y-[2px] flex-col whitespace-nowrap leading-none">
                <span className="flex items-center gap-1.5 truncate text-[11px] font-bold text-white">
                  <span className="truncate pt-[2px]">
                    {eventName || "Event"}
                  </span>

                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      wssConnected
                        ? "bg-green-500"
                        : "bg-neutral-600"
                    }`}
                    title={
                      wssConnected
                        ? "Live updates connected"
                        : "Live updates disconnected"
                    }
                  />
                </span>

                {eventTimezone &&
                  !isDivisional && (
                    <span className="mt-0.5 text-[9px] text-neutral-500">
                      <EventLocalTime
                        timezone={
                          eventTimezone
                        }
                      />
                    </span>
                  )}
              </div>
            </div>
          )}

          {teamPills.length > 0 && (
            <div className="min-w-0 max-w-[calc(100vw-2rem)] overflow-x-auto overflow-y-hidden pb-0.5 no-scrollbar">
              <div className="flex w-max gap-1">
                {teamPills}
              </div>
            </div>
          )}
        </div>
      )}

      {!hideMatchCards && (
        <div className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar">
          {cards.length > 0 ? (
            <div className="flex h-full min-w-max items-center gap-1.5 px-2">
              {cards.map((match) => (
                <MatchCard
                  key={match.key}
                  match={match}
                  team={team}
                  isNext={
                    match.key ===
                    nextMatch?.key
                  }
                  isLast={
                    match.key ===
                    lastMatch?.key
                  }
                  playoffAlliances={
                    playoffAlliances
                  }
                  playoffType={
                    playoffType
                  }
                  eventTimezone={
                    eventTimezone
                  }
                />
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center px-3 text-[10px] text-neutral-600">
              No match data available
            </div>
          )}
        </div>
      )}
    </div>
  );
}