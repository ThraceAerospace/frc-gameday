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

    const trackedUpcoming = Boolean(
      upcomingMatchKey &&
      eventState &&
      hasTrackedTeam(
        eventState.upcomingMatchTeamKeys,
        trackedTeams,
      ),
    );

    if (
      upcomingMatchKey === previous &&
      upcomingMatchKey &&
      eventState &&
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
    eventState,
    trackedTeams,
  ]);

  const activeMatchHighlightRef = useRef<string | null>(null);

  useEffect(() => {
    const nextMatchKey = eventState?.eventNextMatch?.key ?? null;
    const statuses = eventState?.teamsStatuses ?? {};
    const imminentMatchKey =
      autoHighlight && nextMatchKey && trackedTeams.some((team) =>
        statuses[normalizeTeamKey(team)]?.next_match_key === nextMatchKey
      )
        ? nextMatchKey
        : null;
    const activeMatchKey = activeMatchHighlightRef.current;

    if (activeMatchKey && activeMatchKey !== imminentMatchKey) {
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
    eventState?.eventNextMatch?.key,
    eventState?.teamsStatuses,
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
