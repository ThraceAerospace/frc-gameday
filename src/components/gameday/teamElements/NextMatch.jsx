import { formatAlliance, matchCode } from "@/lib/tbaFormatters";
import NextMatchCountdown from "../navbar/NextMatchCountdown";

export default function NextMatch({ match, team }) {
  if (!match) return null;

  return (
    <div className="bg-neutral-800 p-2 rounded flex gap-2 items-center">
      <div>
        <div className="text-center">{matchCode(match.key)}</div>
        <div className="text-nowrap">
          {match.predicted_time ? (
            <NextMatchCountdown nextMatch={match} timezone={team?.event?.timezone} />
          ) : (
            <span className="text-sm text-gray-400"></span>
          )}
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