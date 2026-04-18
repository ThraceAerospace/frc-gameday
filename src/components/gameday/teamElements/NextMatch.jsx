import { formatAlliance, matchCode } from "@/lib/tbaFormatters";
import NextMatchCountdown from "../navbar/NextMatchCountdown";
import { matchShortName } from "../../../lib/tbaFormatters";
import MatchCard from "../navbar/MatchCard";

export default function NextMatch({ match, team, playoffAlliances, eventPlayoffType, eventTimezone }) {
  if (!match) return null;

  return (
    <MatchCard 
      key={match.key}
      match={match}
      team={team}
      isNext={true}
      playoffAlliances={playoffAlliances}
      eventPlayoffType={eventPlayoffType}
      eventTimezone={eventTimezone}
    />
    // <div className="bg-neutral-800 p-2 rounded flex gap-2 items-center">
    //   <div>
    //     <div className="text-center">{matchShortName(match, -1)}</div>
    //     <div className="text-nowrap">
    //       {match.predicted_time ? (
    //         <NextMatchCountdown nextMatch={match} timezone={team?.event?.timezone} />
    //       ) : (
    //         <span className="text-sm text-gray-400"></span>
    //       )}
    //     </div>
    //   </div>

    //   <div className="flex-col">
    //     <div className="text-red-400 text-nowrap">
    //       {formatAlliance(match.alliances.red.team_keys, team?.key)}
    //     </div>

    //     <div className="text-blue-400 text-nowrap">
    //       {formatAlliance(match.alliances.blue.team_keys, team?.key)}
    //     </div>
    //   </div>
    // </div>
  );
}