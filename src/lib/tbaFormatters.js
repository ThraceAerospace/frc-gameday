export function formatTeamKey(teamKey, trackedTeams = []) {
  const num = teamKey.replace("frc", "");

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

export function formatAlliance(teamKeys = [], trackedTeams = []) {
  return teamKeys.map((t) => formatTeamKey(t, trackedTeams));
}

export function matchCode(matchKey) {
  try {
    return matchKey.split("_")[1].toUpperCase().replace(/(?<!Q)M/g, "-");
  } catch {
    return "UN";
  }
}

export function matchShortName(match, eventPlayoffType) {
  try {
    const compLevel = match.comp_level;
    const matchNum = match.match_number;
    const setNum = match.set_number;
    // console.log("matchShortName", {compLevel, matchNum, setNum, eventPlayoffType});
    switch (compLevel.toUpperCase()) {
      case "F":
        return `Final ${matchNum}`;
      case "SF":
        if (eventPlayoffType === 10 || eventPlayoffType === 11 || eventPlayoffType === 5) { //https://github.com/the-blue-alliance/the-blue-alliance/blob/main/src/backend/common/consts/playoff_type.py 10 = 8 team double elim, 11 = 4 team double elim, 5 = legacy double elim from before FRC adopted double elim brackets in 2023
          return `Playoff ${setNum}`; // In double elim formats, the "semifinals" are actually just the first round of playoffs, so we label them as such instead of "semis"
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