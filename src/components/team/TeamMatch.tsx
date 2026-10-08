import Link from "next/link";
import type { TBAEventSimple, TBAMatch } from "@/lib/tba/types";

function teamNumber(teamKey: string): string {
  return teamKey.replace(/^frc/i, "");
}

function formatMatchName(match: TBAMatch): string {
  const set = match.set_number ?? 0;
  const number = match.match_number ?? 0;

  if (match.comp_level === "qm") return `Qualification ${number}`;
  if (match.comp_level === "ef") return `Eighthfinal ${set}-${number}`;
  if (match.comp_level === "qf") return `Quarterfinal ${set}-${number}`;
  if (match.comp_level === "sf") return `Semifinal ${set}-${number}`;
  if (match.comp_level === "f") return `Final ${number}`;
  return match.key;
}

function allianceClasses(alliance: "red" | "blue") {
  return alliance === "red"
    ? "border-red-200 bg-red-50 text-red-800 hover:bg-red-100"
    : "border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100";
}

function AllianceTeams({
  teamKeys,
  alliance,
  highlightedTeamKey,
}: {
  teamKeys: string[];
  alliance: "red" | "blue";
  highlightedTeamKey: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {teamKeys.map((teamKey) => (
        <Link
          key={teamKey}
          href={`/team/${teamKey}`}
          className={`rounded-md border px-2 py-1 font-mono text-xs font-bold transition ${allianceClasses(alliance)} ${teamKey === highlightedTeamKey ? "ring-2 ring-slate-400 ring-offset-1" : ""}`}
        >
          {teamNumber(teamKey)}
        </Link>
      ))}
    </div>
  );
}

export default function TeamMatch({
  event,
  match,
  teamKey,
}: {
  event: TBAEventSimple;
  match: TBAMatch;
  teamKey: string;
}) {
  const redScore = match.alliances?.red?.score;
  const blueScore = match.alliances?.blue?.score;
  const isPlayed =
    redScore != null &&
    blueScore != null &&
    redScore >= 0 &&
    blueScore >= 0;

  const isRed = match.alliances?.red?.team_keys?.includes(teamKey) ?? false;
  const teamAlliance = isRed ? match.alliances?.red : match.alliances?.blue;
  const opponentAlliance = isRed ? match.alliances?.blue : match.alliances?.red;

  let result = "Upcoming";
  if (isPlayed && teamAlliance && opponentAlliance) {
    if (teamAlliance.score > opponentAlliance.score) result = "Win";
    else if (teamAlliance.score < opponentAlliance.score) result = "Loss";
    else result = "Tie";
  }

  const resultClass =
    result === "Win"
      ? "font-bold text-emerald-600"
      : result === "Loss"
        ? "font-bold text-red-600"
        : result === "Tie"
          ? "font-bold text-amber-600"
          : "font-semibold text-slate-400";

  return (
    <div className="border-t border-slate-100 px-4 py-3 first:border-t-0">
      <div className="grid gap-3 lg:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)_110px] lg:items-center">
        <div>
          <Link
            href={`/event/${event.key}/match/${match.key}`}
            className="font-semibold text-slate-900 hover:text-blue-600"
          >
            {formatMatchName(match)}
          </Link>
          <p className="mt-0.5 text-xs text-slate-400">
            {isPlayed ? "Final" : "Upcoming"}
          </p>
        </div>

        <div className="min-w-0">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-red-500">
            Red {redScore != null && redScore >= 0 ? redScore : "—"}
          </p>
          <AllianceTeams
            teamKeys={match.alliances?.red?.team_keys ?? []}
            alliance="red"
            highlightedTeamKey={teamKey}
          />
        </div>

        <div className="min-w-0">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-blue-500">
            Blue {blueScore != null && blueScore >= 0 ? blueScore : "—"}
          </p>
          <AllianceTeams
            teamKeys={match.alliances?.blue?.team_keys ?? []}
            alliance="blue"
            highlightedTeamKey={teamKey}
          />
        </div>

        <div className={resultClass}>
          {teamAlliance && opponentAlliance && isPlayed
            ? `${result} ${teamAlliance.score}-${opponentAlliance.score}`
            : result}
        </div>
      </div>
    </div>
  );
}
