import type { ReactNode } from "react";
import type { TBAMatch, TBAEliminationAlliance } from "@/lib/tba/types";

export function formatTeamKey(teamKey: string, trackedTeams: string[] = []): ReactNode {
  const num = formatTeamNumber(teamKey);

  const isTracked =
    Array.isArray(trackedTeams)
      ? trackedTeams.includes(teamKey)
      : trackedTeams === teamKey;

  const className = isTracked ? "font-bold underline p-1" : "p-1";

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
    // console.log("matchShortName", {compLevel, matchNum, setNum, eventPlayoffType});
    switch (compLevel.toUpperCase()) {
      case "F":
        return `Final ${matchNum}`;
      case "SF":
        if (eventPlayoffType === 10 || eventPlayoffType === 11) {
          if ([1, 2, 3, 4, 7, 8, 11].includes(setNum)) {
            return `Playoff ${setNum} [UB]`;
          } else if ([5, 6, 9, 10, 12, 13].includes(setNum)) {
            return `Playoff ${setNum} [LB]`;
          } else {
            return `Playoff ${setNum}`;
          }
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
        if (eventPlayoffType === 10 || eventPlayoffType === 11) {
          if ([1, 2, 3, 4, 7, 8, 11].includes(setNum)) {
            return `Playoff ${setNum} [UB]`;
          } else if ([5, 6, 9, 10, 12, 13].includes(setNum)) {
            return `Playoff ${setNum} [LB]`;
          } else {
            return `Playoff ${setNum}`;
          }
        } else if (eventPlayoffType === 5) {
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
