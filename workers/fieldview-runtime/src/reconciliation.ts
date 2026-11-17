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

/** Apply a full-match or upcoming-match webhook patch to the event match list. */
export function reconcileWebhookEndpoint(
  endpoint: string,
  latest: unknown,
  incoming: unknown,
): unknown {
  if (!endpoint.endsWith("/matches") || !isRecord(incoming)) {
    return incoming;
  }
  const key = matchKey(incoming);
  if (!key) return incoming;
  if (!Array.isArray(latest)) return [incoming];

  let found = false;
  const merged = latest.map((match) => {
    if (matchKey(match) !== key) return match;
    found = true;
    return isRecord(match) ? { ...match, ...incoming } : incoming;
  });
  if (!found) merged.push(incoming);
  return merged;
}
