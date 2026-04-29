"use client";

import MatchCard from "./MatchCard";

export default function MatchList({
  matches = [],
  team,
  nextMatchKey,
  lastMatchKey,
  eventTimezone,
  playoffAlliances = [],
  eventPlayoffType,
}) {
  if (!matches.length) return null;
  const futureMatches = matches.filter((m) => m.actual_time === null && m.key !== nextMatchKey.key);
  return (
    <div className="flex gap-2 w-full overflow-x-auto no-scrollbar">
      <MatchCard 
        key={lastMatchKey?.key } 
        match={lastMatchKey} 
        team={team}
        isNext={lastMatchKey === nextMatchKey}
        isLast={lastMatchKey === lastMatchKey}
        playoffAlliances={playoffAlliances}
        eventPlayoffType={eventPlayoffType}
        eventTimezone={eventTimezone} 
      />
      <MatchCard 
        key={nextMatchKey?.key} 
        match={nextMatchKey} 
        team={team}
        isNext={nextMatchKey === nextMatchKey}
        isLast={nextMatchKey === lastMatchKey}
        playoffAlliances={playoffAlliances}
        eventPlayoffType={eventPlayoffType}
        eventTimezone={eventTimezone} 
      />
      {futureMatches.map((m) => (
        <MatchCard
          key={m.key}
          match={m}
          team={team}
          isNext={m.key === nextMatchKey}
          isLast={m.key === lastMatchKey}
          playoffAlliances={playoffAlliances}
          eventPlayoffType={eventPlayoffType}
          eventTimezone={eventTimezone}
        />
      ))}
    </div>
  );
}