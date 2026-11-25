/**
 * Explicit endpoint-specific reconciliation for unchanged TBA resource values.
 * These functions associate/merge records; they do not rename or reinterpret
 * provider fields. Keep provider payloads intact.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMatchResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const alliances = isRecord(value.alliances) ? value.alliances : null;
  const red = alliances && isRecord(alliances.red) ? alliances.red : null;
  const blue = alliances && isRecord(alliances.blue) ? alliances.blue : null;
  const redScore = red?.score;
  const blueScore = blue?.score;
  return value.actual_time != null ||
    value.post_result_time != null ||
    value.score_breakdown != null ||
    (typeof redScore === "number" && redScore >= 0) ||
    (typeof blueScore === "number" && blueScore >= 0);
}

function matchKey(value: unknown): string | null {
  return isRecord(value) && typeof value.key === "string" ? value.key : null;
}

/** Preserve completed match results and cached matches omitted by a partial poll. */
export function reconcilePolledEndpoint(
  endpoint: string,
  latest: unknown,
  fetched: unknown,
): unknown {
  if (!endpoint.endsWith("/matches") || !Array.isArray(latest) || !Array.isArray(fetched)) {
    return fetched;
  }

  const latestByKey = new Map<string, unknown>();
  for (const match of latest) {
    const key = matchKey(match);
    if (key) latestByKey.set(key, match);
  }

  const fetchedKeys = new Set<string>();
  const merged = fetched.map((match) => {
    const key = matchKey(match);
    if (!key) return match;
    fetchedKeys.add(key);
    const previous = latestByKey.get(key);
    return previous !== undefined && hasMatchResult(previous) && !hasMatchResult(match)
      ? previous
      : match;
  });

  for (const match of latest) {
    const key = matchKey(match);
    if (key && !fetchedKeys.has(key)) merged.push(match);
  }
  return merged;
}

/** Convert the webhook Match alliance `teams` field to the canonical API `team_keys` field. */
export function normalizeTbaWebhookMatch(incoming: Record<string, unknown>): Record<string, unknown> {
  const alliances = incoming.alliances;
  if (!isRecord(alliances)) return incoming;
  const normalized: Record<string, unknown> = { ...alliances };
  for (const color of ["red", "blue"]) {
    const alliance = normalized[color];
    if (!isRecord(alliance)) continue;
    const { teams, ...fields } = alliance;
    normalized[color] = {
      ...fields,
      ...(Array.isArray(teams) ? { team_keys: teams } : {}),
    };
  }
  return { ...incoming, alliances: normalized };
}

/** Merge a normalized webhook Match patch without erasing omitted alliance fields. */
export function mergeTbaWebhookMatch(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const currentAlliances = isRecord(current.alliances) ? current.alliances : null;
  const incomingAlliances = isRecord(incoming.alliances) ? incoming.alliances : null;
  if (!currentAlliances || !incomingAlliances) return { ...current, ...incoming };
  const alliances: Record<string, unknown> = { ...currentAlliances };
  for (const color of ["red", "blue"]) {
    const previous = currentAlliances[color];
    const update = incomingAlliances[color];
    if (isRecord(previous) && isRecord(update)) {
      alliances[color] = { ...previous, ...update };
    } else if (update !== undefined) {
      alliances[color] = update;
    }
  }
  return { ...current, ...incoming, alliances };
}

/** Apply a full-match or upcoming-match webhook patch to the event match list. */
export function reconcileWebhookEndpoint(
  endpoint: string,
  latest: unknown,
  incoming: unknown,
): unknown {
  if (!endpoint.endsWith("/matches") || !isRecord(incoming)) {
    return incoming;
  }
  const normalizedIncoming = normalizeTbaWebhookMatch(incoming);
  const key = matchKey(normalizedIncoming);
  if (!key) return normalizedIncoming;
  if (!Array.isArray(latest)) return [normalizedIncoming];

  let found = false;
  const merged = latest.map((match) => {
    if (matchKey(match) !== key) return match;
    found = true;
    return isRecord(match) ? mergeTbaWebhookMatch(match, normalizedIncoming) : normalizedIncoming;
  });
  if (!found) merged.push(normalizedIncoming);
  return merged;
}
