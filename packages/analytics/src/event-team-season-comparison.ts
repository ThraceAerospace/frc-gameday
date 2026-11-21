import type { FieldViewEvent } from "../../domain/src/event.ts";
import type { FieldViewTeamState } from "../../domain/src/team.ts";
import type {
  FieldViewEventTeamSeasonRecord,
  FieldViewEventTeamSeasonComparisonInput,
} from "../../domain/src/analytics.ts";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fetchedAt(snapshot: FieldViewTeamState, fallback: number): number {
  const retrievedAt = snapshot.sources.statbotics_team_events?.retrieved_at;
  if (typeof retrievedAt !== "string") return fallback;
  const parsed = Date.parse(retrievedAt);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build the event-wide comparison cohort exclusively from TeamRuntime
 * snapshots. Missing team/event/model records remain explicit unavailable
 * records; they are never converted to zero or silently omitted.
 */
export function buildFieldViewEventTeamSeasonComparisonInput(
  targetEvent: Pick<FieldViewEvent, "key" | "name" | "event_code" | "start_date">,
  teamNumbers: number[],
  snapshots: Array<FieldViewTeamState | null>,
  updatedAt = Date.now(),
): FieldViewEventTeamSeasonComparisonInput {
  const snapshotByTeam = new Map<number, FieldViewTeamState>();
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    const parsedKey = Number(snapshot.team_key.replace(/^frc/i, ""));
    const number = finite(snapshot.team?.team_number) ??
      (Number.isSafeInteger(parsedKey) && parsedKey > 0 ? parsedKey : null);
    if (number !== null) snapshotByTeam.set(number, snapshot);
  }

  const records: FieldViewEventTeamSeasonRecord[] = [];
  let discoveryPendingTeams = 0;
  let historyUnavailableTeams = 0;
  let expectedRecords = 0;

  for (const teamNumber of teamNumbers) {
    const snapshot = snapshotByTeam.get(teamNumber) ?? null;
    const availableEvents = snapshot?.events;
    if (!snapshot) {
      discoveryPendingTeams += 1;
    } else if (availableEvents === undefined || availableEvents === null) {
      const historySourceStatus = snapshot.sources.tba_team_events?.status;
      if (historySourceStatus === "failed" || historySourceStatus === "unavailable") {
        // The resource was attempted and its failure is now terminal evidence,
        // not an indefinitely-discovering cohort. Keep the team row explicit.
        historyUnavailableTeams += 1;
      } else {
        discoveryPendingTeams += 1;
      }
    }

    const officialEvents = (availableEvents ?? [])
      .filter((event) => event.event_type !== 99 && event.event_type !== 100)
      .filter((event) => event.key === targetEvent.key || event.start_date < targetEvent.start_date);
    const eventMap = new Map(officialEvents.map((event) => [event.key, event]));
    eventMap.set(targetEvent.key, {
      key: targetEvent.key,
      name: targetEvent.name,
      event_code: targetEvent.event_code,
      start_date: targetEvent.start_date,
    } as typeof officialEvents[number]);

    const orderedEvents = [...eventMap.values()].sort((a, b) =>
      a.start_date.localeCompare(b.start_date) || a.key.localeCompare(b.key));
    expectedRecords += orderedEvents.length;
    const statboticsByEvent = new Map((snapshot?.statbotics_events ?? []).flatMap((record) =>
      typeof record.event === "string" ? [[record.event, record] as const] : [],
    ));
    const fetched = snapshot ? fetchedAt(snapshot, updatedAt) : updatedAt;

    for (const event of orderedEvents) {
      const statbotics = statboticsByEvent.get(event.key) ?? null;
      const total = statbotics?.record?.total;
      const breakdown = Object.fromEntries(Object.entries(statbotics?.epa?.breakdown ?? {})
        .filter((entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1])));
      records.push({
        team_number: teamNumber,
        event: {
          event_key: event.key,
          event_name: event.name,
          short_name: event.event_code ?? null,
          start_date: event.start_date,
        },
        epa_total: finite(statbotics?.epa?.total_points),
        epa_unitless: finite(statbotics?.epa?.unitless),
        breakdown,
        wins: finite(total?.wins),
        losses: finite(total?.losses),
        ties: finite(total?.ties),
        match_count: finite(total?.count),
        fetched_at: fetched,
        status: statbotics ? "ready" : "unavailable",
      });
    }
  }

  const unavailable = records.filter((record) => record.status === "unavailable").length;
  return {
    state: discoveryPendingTeams > 0 ? "discovering"
      : unavailable > 0 || historyUnavailableTeams > 0 ? "partial" : "complete",
    team_count: teamNumbers.length,
    total_team_event_records: expectedRecords,
    processed_team_event_records: records.length,
    unavailable_team_event_records: unavailable,
    discovery_pending_teams: discoveryPendingTeams,
    history_unavailable_teams: historyUnavailableTeams,
    updated_at: updatedAt,
    records,
  };
}
