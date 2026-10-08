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

  useEffect(() => {
    const upcomingMatchKey = eventState?.upcomingMatchKey ?? null;
    const previous = previousUpcomingMatchRef.current;

    if (upcomingMatchKey !== previous) {
      if (upcomingMatchKey && eventState) {
        const teamKeys = eventState.upcomingMatchTeamKeys;

        if (hasTrackedTeam(teamKeys, trackedTeams)) {
          actions.setUpcomingMatchAlert({
            type: "upcoming_match",
            eventKey,
            matchKey: upcomingMatchKey,
          });
        }
      } else if (previous) {
        actions.setUpcomingMatchAlert({
          type: "upcoming_match_cleared",
          eventKey,
          matchKey: previous,
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

    if (previous !== null && nextMatchKey !== previous) {
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
  }, [
    actions,
    autoHighlight,
    eventKey,
    eventState?.eventNextMatch,
    trackedTeams,
  ]);
}
