"use client";

import {
  useCanonicalEventAnalytics,
  useCanonicalEventSnapshot,
  useCanonicalRuntimeStatus,
} from "@/lib/events";
import type { FieldViewEventSnapshot } from "@fieldview/domain";
import EventAnalyticsDashboard from "./EventAnalyticsDashboard";

/**
 * Runtime snapshots may be intentionally partial while individual TBA resources
 * are still being acquired. Do not let an omitted live resource erase the
 * complete server-rendered snapshot; explicit null/empty values remain authoritative.
 */
function mergeEventSnapshots(
  initial: FieldViewEventSnapshot,
  live: FieldViewEventSnapshot | undefined,
): FieldViewEventSnapshot {
  if (!live) return initial;
  return {
    ...initial,
    ...live,
    event: live.event === undefined ? initial.event : live.event,
    teams: live.teams === undefined ? initial.teams : live.teams,
    event_teams: live.event_teams === undefined ? initial.event_teams : live.event_teams,
    matches: live.matches === undefined ? initial.matches : live.matches,
    playoff_alliances: live.playoff_alliances === undefined ? initial.playoff_alliances : live.playoff_alliances,
    team_states: live.team_states === undefined ? initial.team_states : live.team_states,
    analytics: live.analytics === undefined ? initial.analytics : live.analytics,
    rankings: live.rankings === undefined ? initial.rankings : live.rankings,
    awards: live.awards === undefined ? initial.awards : live.awards,
    advancement_points: live.advancement_points === undefined ? initial.advancement_points : live.advancement_points,
    sources: {
      ...initial.sources,
      ...live.sources,
      event: { ...initial.sources.event, ...live.sources.event },
      teams: { ...initial.sources.teams, ...live.sources.teams },
      event_teams: { ...initial.sources.event_teams, ...live.sources.event_teams },
      matches: { ...initial.sources.matches, ...live.sources.matches },
      playoff_alliances: { ...initial.sources.playoff_alliances, ...live.sources.playoff_alliances },
      rankings: { ...initial.sources.rankings, ...live.sources.rankings },
      awards: { ...initial.sources.awards, ...live.sources.awards },
      advancement_points: { ...initial.sources.advancement_points, ...live.sources.advancement_points },
    },
  };
}

export default function EventAnalyticsSurface({
  eventKey,
  eventName,
  initialSnapshot,
}: {
  eventKey: string;
  eventName: string;
  initialSnapshot: FieldViewEventSnapshot;
}) {
  const liveSnapshot = useCanonicalEventSnapshot(eventKey);
  const analyticsPublication = useCanonicalEventAnalytics(eventKey);
  const websocketStatus = useCanonicalRuntimeStatus(eventKey);

  return (
    <EventAnalyticsDashboard
      eventKey={eventKey}
      eventName={eventName}
      eventState={mergeEventSnapshots(initialSnapshot, liveSnapshot?.snapshot)}
      analyticsPublication={analyticsPublication}
      websocketStatus={websocketStatus}
      websocketStale={false}
    />
  );
}
