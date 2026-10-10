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
          return bracket && round
            ? `${bracket} Bracket - Round ${round} - Match ${setNum}`
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

export function matchShortName(match: TBAMatch, eventPlayoffType: number | null = null): string {
  try {
    const compLevel = match.comp_level;
    const matchNum = match.match_number;
    const setNum = match.set_number;
    // console.log("matchShortName", {compLevel, matchNum, setNum, eventPlayoffType});
    switch (compLevel.toUpperCase()) {
      case "F":
        return `Final ${matchNum}`;
      case "SF":
        if (eventPlayoffType === 10 || eventPlayoffType === 11 || eventPlayoffType === 5) {
            return `Playoff ${setNum}`;
        } else {
          return `Semis ${setNum}-${matchNum}`;
        }
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

/** Consistent W-L-T display for TBA ranking and alliance records. */
export function formatRecord(
  record: { wins?: number | null; losses?: number | null; ties?: number | null } | null | undefined,
): string {
  if (!record) return "—";
  return `${record.wins ?? 0}-${record.losses ?? 0}-${record.ties ?? 0}`;
}

/** Use compact alliance labels (A1, A2) while retaining unknown/custom names. */
export function formatAllianceName(
  name: string | null | undefined,
  fallbackIndex?: number,
): string {
  if (!name) return fallbackIndex == null ? "" : `A${fallbackIndex + 1}`;
  return name.replace(/^Alliance\s+/i, "A");
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
