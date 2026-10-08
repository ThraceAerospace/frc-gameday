"use client";

import { useEffect, useRef } from "react";
import type { EventStateSnapshot } from "@/lib/events/EventState";
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
  eventState: EventStateSnapshot | null;
  trackedTeams: string[];
  autoHighlight: boolean;
  actions: TileSurfaceActions;
};

export function useUpcomingMatchAlert({
  eventKey,
  eventState,
  trackedTeams,
  autoHighlight,
  actions,
}: Options) {
  const previousUpcomingMatchRef = useRef<string | null>(null);
  const previousNextMatchRef = useRef<string | null>(null);
  const nextMatchInitializedRef = useRef(false);

  useEffect(() => {
    const upcomingMatchKey = eventState?.upcomingMatchKey ?? null;
    const previous = previousUpcomingMatchRef.current;

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
        eventState &&
        hasTrackedTeam(
          eventState.upcomingMatchTeamKeys,
          trackedTeams,
        )
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
    eventState,
    trackedTeams,
  ]);

  useEffect(() => {
    const nextMatchKey = eventState?.eventNextMatch?.key ?? null;
    const previous = previousNextMatchRef.current;

    if (nextMatchInitializedRef.current && nextMatchKey !== previous) {
      const nextMatch = eventState?.eventNextMatch;
      const teamKeys = [
        ...(nextMatch?.alliances.red.team_keys ?? []),
        ...(nextMatch?.alliances.blue.team_keys ?? []),
      ];

      if (
        nextMatch &&
        autoHighlight &&
        hasTrackedTeam(teamKeys, trackedTeams)
      ) {
        actions.highlightEvent(eventKey);
      }
    }

    previousNextMatchRef.current = nextMatchKey;
    nextMatchInitializedRef.current = true;
  }, [
    actions,
    autoHighlight,
    eventKey,
    eventState?.eventNextMatch,
    trackedTeams,
  ]);
}
