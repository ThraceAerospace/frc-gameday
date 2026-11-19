import type { TBAMatch } from "@fieldview/provider-tba/types";

/** Match label formatting used by the analytics calculations. */
function doubleEliminationBracket8AllianceInfo(setNum: number): { bracket: "Upper" | "Lower"; round: number } | null {
  const bracket = [1, 2, 3, 4, 7, 8, 11].includes(setNum)
    ? "Upper" : [5, 6, 9, 10, 12, 13].includes(setNum) ? "Lower" : null;
  const round = setNum <= 4 ? 1 : setNum <= 8 ? 2 : setNum <= 10 ? 3 : setNum <= 12 ? 4 : setNum === 13 ? 5 : null;
  return bracket && round ? { bracket, round } : null;
}
function doubleEliminationBracket4AllianceInfo(setNum: number): { bracket: "Upper" | "Lower"; round: number } | null {
  const bracket = [1, 2, 3].includes(setNum) ? "Upper" : [4, 5].includes(setNum) ? "Lower" : null;
  const round = setNum <= 2 ? 1 : setNum <= 4 ? 2 : setNum <= 5 ? 3 : null;
  return bracket && round ? { bracket, round } : null;
}

export function matchShortName(
  match: Pick<TBAMatch, "comp_level" | "match_number" | "set_number">,
  eventPlayoffType: number | null = null,
): string {
  try {
    const compLevel = match.comp_level;
    const matchNum = match.match_number;
    const setNum = match.set_number;
    switch (compLevel.toUpperCase()) {
      case "F": return `Final ${matchNum}`;
      case "SF":
        if (eventPlayoffType === 10 || eventPlayoffType === 11) {
          const bracketInfo = eventPlayoffType === 10
            ? doubleEliminationBracket8AllianceInfo(setNum)
            : doubleEliminationBracket4AllianceInfo(setNum);
          const bracket = bracketInfo?.bracket === "Upper" ? "UB" : bracketInfo?.bracket === "Lower" ? "LB" : null;
          return bracket ? `Playoff ${setNum} [${bracket}]` : `Playoff ${setNum}`;
        }
        if (eventPlayoffType === 5) return `Playoff ${setNum}`;
        return `Semis ${setNum}-${matchNum}`;
      case "QF": return `Quarters ${matchNum}`;
      case "EF": return `Eights ${matchNum}`;
      case "QM": return `Qual ${matchNum}`;
      default: return `Match ${matchNum}`;
    }
  } catch { return "UN"; }
}
