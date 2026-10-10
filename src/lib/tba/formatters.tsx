import type { ReactNode } from "react";
import type { TBAMatch, TBAEliminationAlliance } from "@/lib/tba/types";
import { formatEventTime } from "@/lib/time";

export function formatTeamKey(teamKey: string, trackedTeams: string[] = []): ReactNode {
  const num = formatTeamNumber(teamKey);

  const isTracked =
    Array.isArray(trackedTeams)
      ? trackedTeams.includes(teamKey)
      : trackedTeams === teamKey;

  const className = isTracked ? "p-1 font-bold tracked-accent-text" : "p-1";

  return (
    <span key={teamKey} className={className}>
      {num} 
    </span>
  );
}

export function formatAlliance(teamKeys: string[] = [], trackedTeams: string[] = []): ReactNode[] {
  return teamKeys.map((t) => formatTeamKey(t, trackedTeams));
}

export function matchCode(matchKey: string): string {
  try {
    return matchKey.split("_")[1].toUpperCase().replace(/(?<!Q)M/g, "-");
  } catch {
    return "UN";
  }
}

/** Map TBA's playoff set numbers to their double-elimination bracket and round. */
function doubleEliminationBracketInfo(setNum: number): { bracket: "Upper" | "Lower"; round: number } | null {
  const bracket = [1, 2, 3, 4, 7, 8, 11].includes(setNum)
    ? "Upper"
    : [5, 6, 9, 10, 12, 13].includes(setNum)
      ? "Lower"
      : null;
  const round = setNum <= 4
    ? 1
    : setNum <= 8
      ? 2
      : setNum <= 10
        ? 3
        : setNum <= 12
          ? 4
          : setNum === 13
            ? 5
            : null;

  return bracket && round ? { bracket, round } : null;
}

export function matchLongName(match: TBAMatch, eventPlayoffType: number | null = null): string {
  try {
    const compLevel = match.comp_level;
    const matchNum = match.match_number;
    const setNum = match.set_number;
    switch (compLevel.toUpperCase()) {
      case "F":
        if (matchNum > 3) {
          return `Overtime ${matchNum - 3}`;
        }
        return `Final ${matchNum}`;
      case "SF":
        if (eventPlayoffType === 10 || eventPlayoffType === 11) {
          const bracketInfo = doubleEliminationBracketInfo(setNum);
          return bracketInfo
            ? `${bracketInfo.bracket} Bracket - Round ${bracketInfo.round} - Match ${setNum}`
            : `Playoff ${setNum}`;
        } else if (eventPlayoffType === 5) {
          return `Playoff ${setNum}`;
        } else {
          return `Semifinal ${setNum} Match ${matchNum}`;
        }
      case "QF":
        return `Quarterfinal ${setNum} Match ${matchNum}`;
      case "EF":
        return `Eighthfinal ${setNum} Match ${matchNum}`;
      case "QM":
         return `Qualification ${matchNum}`;
      case "PM":
        return `Practice ${matchNum}`;
      default:
        return `Match ${matchNum}`;
    }
  } catch {
    return "UN";
  }
}

/** Resolve the double-elimination round from the shared bracket mapping. */
function doubleEliminationRound(setNum: number): number | null {
  return doubleEliminationBracketInfo(setNum)?.round ?? null;
}

export function matchShortName(match: TBAMatch, eventPlayoffType: number | null = null): string {
  try {
    const compLevel = match.comp_level;
    const matchNum = match.match_number;
    const setNum = match.set_number;

    switch (compLevel.toUpperCase()) {
      case "F":
        return `Final ${matchNum}`;
      case "SF":
        if (eventPlayoffType === 10) {
          const round = doubleEliminationRound(setNum);
          return round == null ? `R?${matchNum}` : `R${round}-${matchNum}`;
        }
        if (eventPlayoffType === 11 || eventPlayoffType === 5) {
          return `Playoff ${setNum}`;
        }
        return `SF${setNum}-${matchNum}`;
      case "QF":
        return `Quarters ${matchNum}`;
      case "EF":
        return `Eights ${matchNum}`;
      case "QM":
        return `Qual ${matchNum}`;
      default:
        return `Match ${matchNum}`;
    }
  } catch {
    return "UN";
  }
}

export function compLevelShortName(compLevel: string): string {
  switch (compLevel.toUpperCase()) {
    case "F":
      return "Finals";
    case "SF":
      return "Semifinals";
    case "QF":
      return "Quarterfinals";
    case "EF":
      return "Eighth Finals";
    case "QM":
      return "Qualifications";
    default:
      return compLevel.toUpperCase();
  }
}

/** Return a display-ready team number without the TBA `frc` key prefix. */
export function formatTeamNumber(teamKey: string | number | null | undefined): string {
  return String(teamKey ?? "").replace(/^frc/i, "");
}

/**
 * Remove the suffix TBA appends to some event names, notably FIRST
 * Championship, so event labels remain concise and consistent everywhere.
 */
export function formatEventName(
  eventName: string | null | undefined,
  fallback = "",
): string {
  const name = eventName?.replace(/ - FIRST Robotics Competition$/, "").trim();
  return name || fallback;
}

/** Normalize score values for display; TBA uses negative scores for unplayed matches. */
export function formatScore(score: number | null | undefined): number | string {
  return score == null || score < 0 ? "—" : score;
}

/** Turn TBA score-breakdown keys such as autoPoints into readable labels. */
export function formatScoreBreakdownLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

/** Consistent, color-coded W-L-T display for TBA ranking and alliance records. */
export function formatRecord(
  record: { wins?: number | null; losses?: number | null; ties?: number | null } | null | undefined,
): ReactNode {
  if (!record) return "—";

  const wins = record.wins ?? 0;
  const losses = record.losses ?? 0;
  const ties = record.ties ?? 0;

  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
      <span className="text-green-400">{wins}</span>
      <span className="text-neutral-400">-</span>
      <span className="text-red-400">{losses}</span>
      {ties > 0 && (
        <>
          <span className="text-neutral-400">-</span>
          <span className="text-neutral-300">{ties}</span>
        </>
      )}
    </span>
  );
}

/** Use compact alliance labels (A1, A2) while retaining unknown/custom names. */
export function formatAllianceShortName(
  name: string | null | undefined,
  fallbackIndex?: number,
): string {
  if (!name) return fallbackIndex == null ? "" : `A${fallbackIndex + 1}`;
  return name.replace(/^Alliance\s+/i, "A");
}

export function formatAllianceLongName(
  name: string | null | undefined,
  fallbackIndex?: number,
): string {
  if (!name) return "Alliance";
  return name;
}


/** Format the TBA playoff status according to the event's bracket type. */
export function formatPlayoffLevel(
  alliance: Pick<TBAEliminationAlliance, "status">,
  playoffType?: number | null,
): string {
  const status = alliance.status;
  if (!status) return "—";
  if (playoffType === 10) return status.double_elim_round ?? "—";
  return status.level ?? "—";
}


/** Human-readable name for a TBA competition level. */
export function formatMatchType(compLevel: string | null | undefined): string {
  switch (compLevel?.toLowerCase()) {
    case "qm": return "Qualification Match";
    case "ef": return "Eighthfinal Match";
    case "qf": return "Quarterfinal Match";
    case "sf": return "Semifinal Match";
    case "f": return "Final Match";
    default: return "Competition Match";
  }
}

/** Local-time display used by the event schedule, with a consistent missing-time label. */
export function formatMatchTime(timestampSeconds: number | null | undefined): string {
  if (timestampSeconds == null) return "—";
  return new Date(timestampSeconds * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}


/** Format a TBA match timestamp in the event's timezone. */
export function formatMatchEventTime(
  timestampSeconds: number | null | undefined,
  eventTimeZone?: string | null,
): string {
  if (timestampSeconds == null) return "—";
  return formatEventTime(timestampSeconds, eventTimeZone ?? undefined);
}


/** Whether a TBA competition level is an elimination round. */
export function isEliminationMatch(compLevel: string | null | undefined): boolean {
  return ["ef", "qf", "sf", "f"].includes(compLevel?.toLowerCase() ?? "");
}

/**
 * Find the playoff alliance represented by a match alliance's team keys.
 * Require at least two overlapping teams to avoid false matches from one team.
 */
export function formatPlayoffAllianceName(
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

  return bestMatch && bestMatch.overlap >= 2 ? bestMatch.name : null;
}
