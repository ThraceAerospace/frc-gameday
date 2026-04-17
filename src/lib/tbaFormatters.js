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