import NextMatchCountdown from "./NextMatchCountdown";
import { formatAlliance, matchShortName } from "@/lib/tbaFormatters";
import { formatEventTime } from "../../../lib/time";

export default function MatchCard({ match, team, isNext, isLast, playoffAlliances, eventPlayoffType, eventTimezone }) {
    if (!match) return null;
    if (!playoffAlliances) playoffAlliances = [];

    const red = match?.alliances?.red?.team_keys || [];
    const blue = match?.alliances?.blue?.team_keys || [];
    const isTrackedInRed = team && red.includes(team.key);
    const isTrackedInBlue = team && blue.includes(team.key);

    const isPlayoff = match.comp_level !== "qm";
    const hasAlliances = playoffAlliances.length > 0

    const playoffRedAlliance = hasAlliances &&  playoffAlliances.find(a =>
        a.picks.some(pick => match.alliances.red.team_keys.includes(pick))
    );

    const playoffBlueAlliance = hasAlliances && playoffAlliances.find(a =>
        a.picks.some(pick => match.alliances.blue.team_keys.includes(pick))
    );
    return (
        <div key={match.key} className="bg-neutral-800 p-2 rounded flex gap-2 items-center shrink-0">
            <div className="flex flex-col">
                <div className="text-center">{matchShortName(match, eventPlayoffType)}</div>
                <div className="text-center">
                {match.predicted_time && !isNext && !isLast
                    ? <span className="text-xs text-gray-400">{formatEventTime(match.predicted_time, eventTimezone)}</span>
                    : isNext ? <NextMatchCountdown nextMatch={match} timezone={team?.event?.timezone} /> : ""
                }
                { isLast ? (
                    <div className="text-nowrap">
                        <span className={`text-red-500 ${isTrackedInRed ? 'font-bold' : ''}`}>{match?.alliances.red.score}</span> - <span className={`text-blue-500 ${isTrackedInBlue ? 'font-bold' : ''}`}>{match?.alliances.blue.score}</span>
                    </div>
                    ) : null
                }
                </div>
            </div>

            <div className="flex flex-col">
                <div className="text-red-400">
                {isPlayoff && playoffRedAlliance ? (
                <span className="text-red-500 text-sm gap-1">
                    {playoffRedAlliance.name?.replace("Alliance ", "A").trim() || ""}
                </span>
                ) : null}
                {formatAlliance(red, team?.key)}
                </div>
                <div className="text-blue-400">
                {isPlayoff && playoffBlueAlliance ? (
                <span className="text-blue-500 text-sm gap-1">
                    {playoffBlueAlliance.name?.replace("Alliance ", "A").trim() || ""}
                </span>
                ) : null}
                {formatAlliance(blue, team?.key)}
                </div>
            </div>
        </div>
    )
}