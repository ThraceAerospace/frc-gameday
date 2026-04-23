"use client";

import { formatAlliance, matchCode } from "@/lib/tbaFormatters";
import { formatEventTime } from "../../../lib/time";
import { matchShortName } from "../../../lib/tbaFormatters";
import MatchCard from "./MatchCard";

export default function MatchList({
  matches = [],
  team,
  nextMatchKey,
  eventTimezone,
  teamView,
  playoffAlliances = [],
  eventPlayoffType,
}) {
  if (!matches.length) return null;

  const now = Date.now();
  

  const filtered = matches.filter((m) => {
    const isPlayed = m.actual_time != null;

    const isTeamMatch =
      teamView?.enabled &&
      m.isTeamMatch &&
      m.key !== nextMatchKey;

    return (
      (isTeamMatch && !isPlayed) ||
      (!teamView?.enabled && !isPlayed && m.key !== nextMatchKey)
    );
  });

  const sorted = [...filtered].sort(
    (a, b) => (a?.predicted_time || 0) - (b?.predicted_time || 0)
  );

  return (
  <div className="flex gap-2 w-full overflow-x-auto no-scrollbar">
      {sorted.map((m) => {        
        return (
          <MatchCard 
            key={m.key}
            match={m}
            team={team}
            isNext={m.key === nextMatchKey}
            playoffAlliances={playoffAlliances}
            eventPlayoffType={eventPlayoffType}
            eventTimezone={eventTimezone}
          />
        );
      })}
    </div>
  );
}