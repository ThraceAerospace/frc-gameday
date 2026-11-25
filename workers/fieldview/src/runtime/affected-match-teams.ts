/**
 * Return the team runtimes whose event-scoped projections may have changed
 * when a TBA match collection changes. A missing prior collection represents
 * first acquisition, so every team in the new collection is affected.
 *
 * null means the collection cannot be compared safely; callers must not
 * silently interpret an incomplete comparison as an empty affected set.
 */
export function affectedTeamsForChangedMatches(previous: unknown, next: unknown): string[] | null {
  if (!Array.isArray(next)) return null;
  const teamKeys = (match: unknown): string[] => {
    if (!match || typeof match !== "object" || Array.isArray(match)) return [];
    const alliances = (match as Record<string, unknown>).alliances;
    if (!alliances || typeof alliances !== "object" || Array.isArray(alliances)) return [];
    const result = new Set<string>();
    for (const color of ["red", "blue"]) {
      const alliance = (alliances as Record<string, unknown>)[color];
      if (!alliance || typeof alliance !== "object" || Array.isArray(alliance)) continue;
      const keys = (alliance as Record<string, unknown>).team_keys;
      if (!Array.isArray(keys)) continue;
      for (const key of keys) if (typeof key === "string" && /^frc\\d+$/.test(key)) result.add(key);
    }
    return [...result];
  };
  const keyOf = (match: unknown): string | null =>
    match && typeof match === "object" && !Array.isArray(match) &&
    typeof (match as Record<string, unknown>).key === "string"
      ? (match as Record<string, unknown>).key as string : null;
  const projection = (match: unknown): unknown => {
    if (!match || typeof match !== "object" || Array.isArray(match)) return match;
    const value = match as Record<string, unknown>;
    const alliances = value.alliances && typeof value.alliances === "object" && !Array.isArray(value.alliances)
      ? value.alliances as Record<string, unknown> : {};
    const alliance = (color: "red" | "blue") => {
      const side = alliances[color];
      if (!side || typeof side !== "object" || Array.isArray(side)) return null;
      const item = side as Record<string, unknown>;
      return { team_keys: item.team_keys, score: item.score };
    };
    return {
      key: value.key, event_key: value.event_key, comp_level: value.comp_level,
      set_number: value.set_number, match_number: value.match_number,
      alliances: { red: alliance("red"), blue: alliance("blue") },
      winning_alliance: value.winning_alliance, score_breakdown: value.score_breakdown,
    };
  };
  if (!Array.isArray(previous)) {
    return [...new Set(next.flatMap(teamKeys))].sort();
  }
  const index = (matches: unknown[]): Map<string, unknown> | null => {
    const entries = new Map<string, unknown>();
    for (const match of matches) {
      const key = keyOf(match);
      if (key === null || entries.has(key)) return null;
      entries.set(key, projection(match));
    }
    return entries;
  };
  const before = index(previous);
  const after = index(next);
  if (!before || !after || before.size !== previous.length || after.size !== next.length) return null;
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)));
  if (!changed.length) return [];
  const changedKeys = new Set(changed);
  return [...new Set([...previous, ...next].flatMap((match) =>
    changedKeys.has(keyOf(match) ?? "") ? teamKeys(match) : [],
  ))].sort();
}
