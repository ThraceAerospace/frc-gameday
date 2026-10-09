import Link from "next/link";
import type {
  TBAEliminationAlliance,
  TBAMatch,
} from "@/lib/tba/types";
import { matchLongName } from "@/lib/tba/formatters";

type MatchRowProps = {
  eventKey: string;
  playoffType?: number | null;
  match: TBAMatch;
  playoffAlliances?: TBAEliminationAlliance[] | null;
  highlightedTeamKeys?: string[];
};

function teamNumber(teamKey: string): string {
  return teamKey.replace(/^frc/i, "");
}

function allianceClasses(alliance: "red" | "blue") {
  return alliance === "red"
    ? "border-red-200 bg-red-50 text-red-800 hover:bg-red-100"
    : "border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100";
}

function getPlayoffAllianceName(
  teamKeys: string[],
  playoffAlliances: TBAEliminationAlliance[] | null | undefined,
): string | null {
  if (!playoffAlliances?.length || !teamKeys.length) return null;

  let bestMatch: { name: string; overlap: number } | null = null;

  for (const alliance of playoffAlliances) {
    if (!alliance.name) continue;

    const allianceTeamKeys = new Set([
      ...alliance.picks,
      ...(alliance.backup ? [alliance.backup.in] : []),
    ].map((key) => key.toLowerCase()));
    const overlap = teamKeys.filter((key) =>
      allianceTeamKeys.has(key.toLowerCase()),
    ).length;

    if (overlap > (bestMatch?.overlap ?? 0)) {
      bestMatch = { name: alliance.name, overlap };
    }
  }

  // Two matching teams avoid misidentifying an alliance from a single team.
  return bestMatch && bestMatch.overlap >= 2 ? bestMatch.name : null;
}

function AllianceTeams({
  teamKeys,
  alliance,
  highlightedTeamKeys,
}: {
  teamKeys: string[];
  alliance: "red" | "blue";
  highlightedTeamKeys: string[];
}) {
  const highlighted = new Set(
    highlightedTeamKeys.map((teamKey) => teamKey.toLowerCase()),
  );

  return (
    <div className="flex flex-wrap gap-1.5">
      {teamKeys.map((teamKey) => (
        <Link
          key={teamKey}
          href={`/team/${teamKey}`}
          className={`rounded-md border px-2 py-1 font-mono text-xs font-bold transition ${allianceClasses(alliance)} ${highlighted.has(teamKey.toLowerCase()) ? "ring-2 ring-slate-400 ring-offset-1" : ""}`}
        >
          {teamNumber(teamKey)}
        </Link>
      ))}
    </div>
  );
}

export default function MatchRow({
  eventKey,
  playoffType = null,
  match,
  playoffAlliances,
  highlightedTeamKeys = [],
}: MatchRowProps) {
  const redTeamKeys = match.alliances?.red?.team_keys ?? [];
  const blueTeamKeys = match.alliances?.blue?.team_keys ?? [];
  const isEliminationMatch = ["ef", "qf", "sf", "f"].includes(
    match.comp_level.toLowerCase(),
  );

  const redAllianceName = isEliminationMatch
    ? getPlayoffAllianceName(redTeamKeys, playoffAlliances) ?? "Red"
    : "Red";
  const blueAllianceName = isEliminationMatch
    ? getPlayoffAllianceName(blueTeamKeys, playoffAlliances) ?? "Blue"
    : "Blue";

  const redScore = match.alliances?.red?.score;
  const blueScore = match.alliances?.blue?.score;
  const displayScore = (score: number | null | undefined) =>
    score != null && score >= 0 ? score : "—";

  return (
    <div className="border-t border-slate-100 px-4 py-3 first:border-t-0">
      <div className="grid gap-3 lg:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
        <div>
          <Link
            href={`/event/${eventKey}/match/${match.key}`}
            className="font-semibold text-slate-900 hover:text-blue-600"
          >
            {matchLongName(match, playoffType)}
          </Link>
        </div>

        <div className="min-w-0">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate text-[10px] font-bold uppercase tracking-wider text-red-600">
              {redAllianceName}
            </p>
            <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-red-700">
              {displayScore(redScore)}
            </span>
          </div>
          <AllianceTeams
            teamKeys={redTeamKeys}
            alliance="red"
            highlightedTeamKeys={highlightedTeamKeys}
          />
        </div>

        <div className="min-w-0">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate text-[10px] font-bold uppercase tracking-wider text-blue-600">
              {blueAllianceName}
            </p>
            <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-blue-700">
              {displayScore(blueScore)}
            </span>
          </div>
          <AllianceTeams
            teamKeys={blueTeamKeys}
            alliance="blue"
            highlightedTeamKeys={highlightedTeamKeys}
          />
        </div>
      </div>
    </div>
  );
}
