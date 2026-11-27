"use client";

import { useEffect, useRef } from "react";
import type { FieldViewEventState } from "@fieldview/domain";
import { getNextMatch, sortMatches } from "@/lib/tba/matchUtils";
import type { TileSurfaceActions } from "@/components/surface/TileSurfaceActions";

function normalizeTeamKey(team: string) {
  return team.trim().toLowerCase().startsWith("frc")
    ? team.trim().toLowerCase()
    : `frc${team.trim().toLowerCase()}`;
}

function hasTrackedTeam(
  teamKeys: string[],
  trackedTeams: string[],
) {
  const tracked = new Set(trackedTeams.map(normalizeTeamKey));
  return teamKeys.some((team) => tracked.has(normalizeTeamKey(team)));
}

type Options = {
  eventKey: string;
  snapshot: FieldViewEventState | undefined;
  trackedTeams: string[];
  autoHighlight: boolean;
  actions: TileSurfaceActions;
};

export function useUpcomingMatchAlert({
  eventKey,
  snapshot,
  trackedTeams,
  autoHighlight,
  actions,
}: Options) {
  const previousUpcomingMatchRef = useRef<string | null>(null);

  useEffect(() => {
    const nextMatch = snapshot?.matches ? getNextMatch(sortMatches(snapshot.matches)) : null;
    const upcomingMatchKey = nextMatch?.key ?? null;
    const upcomingMatchTeamKeys = [
      ...(nextMatch?.alliances.red.team_keys ?? []),
      ...(nextMatch?.alliances.blue.team_keys ?? []),
    ];
    const previous = previousUpcomingMatchRef.current;

    const trackedUpcoming = Boolean(
      upcomingMatchKey &&
      snapshot &&
      hasTrackedTeam(
        upcomingMatchTeamKeys,
        trackedTeams,
      ),
    );

    if (
      upcomingMatchKey === previous &&
      upcomingMatchKey &&
      snapshot &&
      !trackedUpcoming
    ) {
      actions.setUpcomingMatchAlert({
        type: "upcoming_match_cleared",
        eventKey,
        matchKey: upcomingMatchKey,
      });
    }

    if (upcomingMatchKey !== previous) {
      if (previous) {
        actions.setUpcomingMatchAlert({
          type: "upcoming_match_cleared",
          eventKey,
          matchKey: previous,
        });
      }

      if (
        upcomingMatchKey &&
        trackedUpcoming
      ) {
        actions.setUpcomingMatchAlert({
          type: "upcoming_match",
          eventKey,
          matchKey: upcomingMatchKey,
        });
      }

      previousUpcomingMatchRef.current = upcomingMatchKey;
    }
  }, [
    actions,
    eventKey,
    snapshot,
    trackedTeams,
  ]);

  const activeMatchHighlightRef = useRef<string | null>(null);

  useEffect(() => {
    const nextMatchKey = snapshot?.matches ? getNextMatch(sortMatches(snapshot.matches))?.key ?? null : null;
    const statuses = Object.fromEntries((snapshot?.event_teams ?? []).map((entry) => [entry.team_key, entry.tba_status]));
    const imminentMatchKey =
      autoHighlight && nextMatchKey && trackedTeams.some((team) =>
        statuses[normalizeTeamKey(team)]?.next_match_key === nextMatchKey
      )
        ? nextMatchKey
        : null;
    const activeMatchKey = activeMatchHighlightRef.current;

    if (activeMatchKey && activeMatchKey !== imminentMatchKey) {
      if (imminentMatchKey) {
        // Register the replacement before releasing the old key so the
        // controller keeps the event's original highlight snapshot.
        actions.highlightMatch(eventKey, imminentMatchKey);
        activeMatchHighlightRef.current = imminentMatchKey;
        actions.releaseMatchHighlight(eventKey, activeMatchKey);
        return;
      }

      actions.releaseMatchHighlight(eventKey, activeMatchKey);
      activeMatchHighlightRef.current = null;
    }

    if (imminentMatchKey && activeMatchHighlightRef.current !== imminentMatchKey) {
      actions.highlightMatch(eventKey, imminentMatchKey);
      activeMatchHighlightRef.current = imminentMatchKey;
    }
  }, [
    actions,
    autoHighlight,
    eventKey,
    snapshot?.matches,
    snapshot?.event_teams,
    trackedTeams,
  ]);

  useEffect(() => () => {
    const matchKey = activeMatchHighlightRef.current;
    if (matchKey) {
      actions.releaseMatchHighlight(eventKey, matchKey);
      activeMatchHighlightRef.current = null;
    }
  }, [actions, eventKey]);
}
