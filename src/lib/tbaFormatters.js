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

export function compLevelShortName(compLevel) {
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