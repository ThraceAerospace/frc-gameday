"use client";

import { formatAlliance, matchCode } from "@/lib/tbaFormatters";

export default function LastMatch({ match, team }) {
  if (!match) return null;

  const redTeams = match?.alliances?.red?.team_keys || [];
  const blueTeams = match?.alliances?.blue?.team_keys || [];

  const isTrackedInRed = team && redTeams.includes(team);
  const isTrackedInBlue = team && blueTeams.includes(team);

  return (
    <div className="bg-neutral-800 p-2 rounded flex gap-2 items-center">
      <div>
        <div className="text-center">{matchCode(match.key)}</div>
        <div className="text-nowrap">
          <span className={`text-red-500 ${isTrackedInRed ? 'font-bold' : ''}`}>{match?.alliances.red.score}</span> - <span className={`text-blue-500 ${isTrackedInBlue ? 'font-bold' : ''}`}>{match?.alliances.blue.score}</span>
        </div>
      </div>

      <div className="flex-col">
        <div className="text-red-400 text-nowrap">
          {formatAlliance(match.alliances.red.team_keys, team.key)}
        </div>

        <div className="text-blue-400 text-nowrap">
          {formatAlliance(match.alliances.blue.team_keys, team.key)}
        </div>
      </div>
    </div>
  );
}