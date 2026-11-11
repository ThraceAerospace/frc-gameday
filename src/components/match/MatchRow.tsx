import Link from "next/link";
import type {
  TBAEliminationAlliance,
  TBAMatch,
} from "@/lib/tba/types";
import {
  formatPlayoffAllianceName,
  formatScoreBreakdownLabel,
  formatScore,
  formatTeamNumber,
  isEliminationMatch,
  matchLongName,
  matchShortName,
} from "@/lib/tba/formatters";

type MatchRowProps = {
  eventKey: string;
  playoffType?: number | null;
  match: TBAMatch;
  playoffAlliances?: TBAEliminationAlliance[] | null;
  highlightedTeamKeys?: string[];
  compact?: boolean;
  firstInGroup?: boolean;
};

function allianceClasses(alliance: "red" | "blue") {
  return alliance === "red"
    ? "border-red-200 bg-red-50 text-red-800 hover:bg-red-100"
    : "border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100";
}

function AllianceTeams({
  teamKeys,
  disqualifiedTeamKeys,
  alliance,
  highlightedTeamKeys,
  compact,
}: {
  teamKeys: string[];
  disqualifiedTeamKeys: string[];
  alliance: "red" | "blue";
  highlightedTeamKeys: string[];
  compact: boolean;
}) {
  const highlighted = new Set(
    highlightedTeamKeys.map((teamKey) => teamKey.toLowerCase()),
  );

  return (
    <div className={compact ? "grid w-full grid-cols-3 gap-1.5" : "flex flex-wrap gap-1.5"}>
      {teamKeys.map((teamKey) => (
        <Link
          key={teamKey}
          href={`/team/${teamKey}`}
          className={`rounded-md border px-2 py-1 text-center font-mono text-xs font-bold transition ${compact ? "w-full px-1" : ""} ${allianceClasses(alliance)} ${disqualifiedTeamKeys.includes(teamKey) ? "line-through decoration-2" : ""} ${highlighted.has(teamKey.toLowerCase()) ? "ring-2 ring-slate-400 ring-offset-1" : ""}`}
        >
          {formatTeamNumber(teamKey)}
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
  compact = false,
  firstInGroup = false,
}: MatchRowProps) {
  const redTeamKeys = match.alliances?.red?.team_keys ?? [];
  const blueTeamKeys = match.alliances?.blue?.team_keys ?? [];
  const isElimination = isEliminationMatch(match.comp_level);

  const redAllianceName = isElimination
    ? formatPlayoffAllianceName(redTeamKeys, playoffAlliances) ?? "Red"
    : "Red";
  const blueAllianceName = isElimination
    ? formatPlayoffAllianceName(blueTeamKeys, playoffAlliances) ?? "Blue"
    : "Blue";

  const redScore = match.alliances?.red?.score;
  const blueScore = match.alliances?.blue?.score;
  const redRankPointAchievements = getAllianceRankPointAchievements(match, "red");
  const blueRankPointAchievements = getAllianceRankPointAchievements(match, "blue");

  return (
    <div className={`event-divider border-t border-slate-100 ${firstInGroup ? "border-t-0" : ""} ${compact ? "px-2 py-2" : "px-4 py-3"}`}>
      <div className={`grid ${compact ? "grid-cols-[104px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2" : "gap-3 lg:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)] lg:items-center"}`}>
        <div>
          <Link
            href={`/event/${eventKey}/match/${match.key}`}
            className={`font-semibold text-slate-900 hover:text-[var(--fv-brand)] ${compact ? "whitespace-nowrap text-xs" : ""}`}
          >
            {compact
              ? matchShortName(match, playoffType)
              : matchLongName(match, playoffType)}
          </Link>
        </div>

        <div className="min-w-0">
          <AllianceScore
            name={redAllianceName}
            score={redScore}
            achievements={redRankPointAchievements}
            alliance="red"
            compact={compact}
          />
          <AllianceTeams
            teamKeys={redTeamKeys}
            disqualifiedTeamKeys={match.alliances?.red?.dq_team_keys ?? []}
            alliance="red"
            highlightedTeamKeys={highlightedTeamKeys}
            compact={compact}
          />
        </div>

        <div className="min-w-0">
          <AllianceScore
            name={blueAllianceName}
            score={blueScore}
            achievements={blueRankPointAchievements}
            alliance="blue"
            compact={compact}
          />
          <AllianceTeams
            teamKeys={blueTeamKeys}
            disqualifiedTeamKeys={match.alliances?.blue?.dq_team_keys ?? []}
            alliance="blue"
            highlightedTeamKeys={highlightedTeamKeys}
            compact={compact}
          />
        </div>
      </div>
    </div>
  );
}

function AllianceScore({
  name,
  score,
  achievements,
  alliance,
  compact,
}: {
  name: string;
  score: number | null | undefined;
  achievements: { key: string; achieved: boolean }[];
  alliance: "red" | "blue";
  compact: boolean;
}) {
  const textColor = alliance === "red" ? "text-red-600" : "text-blue-600";
  const scoreColor = alliance === "red" ? "text-red-700" : "text-blue-700";

  if (compact) {
    return (
      <div className="mb-0.5 flex w-full items-center justify-between gap-2">
        <p className={`truncate text-xs font-bold uppercase tracking-wider ${textColor}`}>
          {name}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <RankPointIndicators achievements={achievements} alliance={alliance} />
          <span className={`font-mono text-sm font-bold tabular-nums ${scoreColor}`}>
            {formatScore(score)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-1 flex items-baseline justify-between gap-3">
      <p className={`min-w-0 truncate text-[10px] font-bold uppercase tracking-wider ${textColor}`}>
        {name}
      </p>
      <span className="flex shrink-0 items-center gap-1">
        <RankPointIndicators achievements={achievements} alliance={alliance} />
        <span className={`font-mono text-sm font-bold tabular-nums ${scoreColor}`}>
          {formatScore(score)}
        </span>
      </span>
    </div>
  );
}

function getAllianceRankPointAchievements(
  match: TBAMatch,
  alliance: "red" | "blue",
) {
  if (isEliminationMatch(match.comp_level)) {
    return [];
  }

  const breakdown = match.score_breakdown?.[alliance];
  if (!breakdown) {
    return [];
  }

  const achievements: { key: string; achieved: boolean }[] = [];
  for (const [key, value] of Object.entries(breakdown)) {
    if (
      typeof value === "boolean" &&
      /(?:rankingpoint(?:achieved)?|bonusachieved|criteriamet|^(?:energized|supercharged|traversal)achieved)$/i.test(key)
    ) {
      achievements.push({ key, achieved: value });
    }
  }

  return achievements;
}

function RankPointIndicators({
  achievements,
  alliance,
}: {
  achievements: { key: string; achieved: boolean }[];
  alliance: "red" | "blue";
}) {
  if (achievements.length === 0) {
    return null;
  }

  const color = alliance === "red" ? "border-red-700" : "border-blue-700";
  const filledColor = alliance === "red" ? "bg-red-700" : "bg-blue-700";
  const label = alliance === "red" ? "Red" : "Blue";

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {achievements.map(({ key, achieved }) => {
        const pointName = formatScoreBreakdownLabel(key);

        return (
          <span
            key={key}
            role="img"
            aria-label={`${label} ${pointName} ${achieved ? "achieved" : "not achieved"}`}
            title={`${pointName}: ${achieved ? "achieved" : "not achieved"}`}
            className={`h-2 w-2 rounded-full border ${color} ${achieved ? filledColor : "bg-white"}`}
          />
        );
      })}
    </span>
  );
}
