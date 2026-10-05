"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
} from "@heroicons/react/24/outline";

import StreamView from "./StreamView";
import StreamModal from "./StreamModal";
import TeamModal from "@/components/team/TeamModal";
import TeamPill from "@/components/team/TeamPill";
import MatchStrip from "@/components/match/MatchStrip";

import { buildStreams } from "@/lib/gameday/buildStreams";
import type { BuiltStream } from "@/lib/gameday/buildStreams";

import { useEvent } from "./hooks/useEvent";
import { useTeams } from "./hooks/useTeams";
import { useTeamsStatuses } from "./hooks/useTeamsStatuses";
import { usePlayoffAlliances } from "./hooks/usePlayoffAlliances";
import { useMatches } from "./hooks/useMatches";
import { useTrackedMatches } from "./hooks/useTrackedMatches";
import { useStreamController } from "./hooks/useStreamController";
import { useWebSocket } from "./hooks/useWebSocket";
import { useMatchImminence } from "../multiview/hooks/useMatchImminence";
import type { MultiviewController } from "../multiview/MultiviewActions";
import type { EventViewConfig } from "./EventViewConfig";

type EventViewProps = {
  event: string;
  config: EventViewConfig;
  controller: MultiviewController;
  isDivisional?: boolean;
};

export default function EventView({
  event,
  config,
  controller,
  isDivisional = false,
}: EventViewProps) {
  const {
    event: eventData,
    loading,
    error,
  } = useEvent(event);

  const { teams } = useTeams(event);

  const {
    teamsStatuses,
    reload: reloadStatuses,
  } = useTeamsStatuses(event);

  const {
    alliances,
    reload: reloadAlliances,
  } = usePlayoffAlliances(event);

  const {
    matches,
    eventNextMatch,
    eventLastMatch,
    reload: reloadMatches,
  } = useMatches(event);

  const eventConfig = config;
  const trackedTeams = eventConfig.trackedTeams;
  const selectedStreamKey = eventConfig.selectedStream;

  const [streamsRaw, setStreamsRaw] =
    useState<BuiltStream[]>([]);

  const [teamsOpen, setTeamsOpen] =
    useState(false);

  const [streamsOpen, setStreamsOpen] =
    useState(false);

  const eventLabel =
    eventData?.short_name ||
    eventData?.name ||
    eventData?.key;

  useEffect(() => {
    if (eventLabel) {
      controller.actions.registerLabel(event, eventLabel);
    }
  }, [event, eventLabel, controller]);

  useEffect(() => {
    let cancelled = false;

    if (!eventData?.webcasts) {
      setStreamsRaw([]);
      return;
    }

    buildStreams(eventData.webcasts).then((streams) => {
      if (!cancelled) {
        setStreamsRaw(streams);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [eventData?.webcasts]);

  const {
    streams,
    activeKey,
    activeStream,
    setActiveKey,
  } = useStreamController(
    streamsRaw,
    eventData?.timezone,
    selectedStreamKey,
  );

  const {
    trackedMatches,
    trackedNextMatch,
    trackedLastMatch,
    trackedNextMatches,
  } = useTrackedMatches(
    matches,
    trackedTeams,
  );

  const teamMode =
    trackedTeams.length > 0;

  const nextMatch = teamMode
    ? trackedNextMatch
    : eventNextMatch;

  const lastMatch = teamMode
    ? trackedLastMatch
    : eventLastMatch;

  const displayMatches = teamMode
    ? trackedMatches
    : matches;

  useMatchImminence(
    teamMode
      ? trackedNextMatch
      : null,
    (signal) => {
      if (
        signal?.type ===
        "match_imminent"
      ) {
        controller.actions.handleMatchImminent(signal);
      }
    },
  );

  const teamCount = useMemo(
    () =>
      Math.max(
        teams.length,
        Object.keys(
          teamsStatuses,
        ).length,
      ),
    [
      teams,
      teamsStatuses,
    ],
  );

  const slotPresentation = eventConfig.presentation;

  const showTeamTracker =
    slotPresentation.teamTracker !== "hidden";

  const teamPills = showTeamTracker
    ? trackedTeams.map((team) => (
        <TeamPill
          key={team}
          team={team}
          status={teamsStatuses[team]}
          teamCount={teamCount}
          nextMatch={trackedNextMatches[team]}
        />
      ))
    : [];

  const refreshLiveData =
    useCallback(() => {
      console.log(
        "[WSS] Refreshing all data sources...",
      );

      void reloadAlliances();
      void reloadMatches();
      void reloadStatuses();
    }, [
      reloadMatches,
      reloadAlliances,
      reloadStatuses,
    ]);

  const {
    connected: wssConnected,
  } = useWebSocket(
    event,
    (message) => {
      if (message.type !== "tba-update") {
        return;
      }

      if (message.eventKey !== event) {
        return;
      }

      if (controller) {
        controller.ingestWebSocketEvent(message, {
          refreshMatches: () => {
            void reloadMatches();
          },
          refreshStatuses: () => {
            void reloadStatuses();
          },
          refreshAlliances: () => {
            void reloadAlliances();
          },
          refreshAll: refreshLiveData,
        });
        return;
      }

      // Standalone EventView instances still own their refresh lifecycle.
      // Multiview instances always pass the controller above.
      switch (message.messageType) {
        case "upcoming_match":
        case "match_score":
        case "match_video":
          void reloadMatches();
          void reloadStatuses();
          break;

        case "starting_comp_level":
        case "schedule_updated":
          refreshLiveData();
          break;

        case "alliance_selection":
          void reloadAlliances();
          void reloadStatuses();
          void reloadMatches();
          break;

        default:
          refreshLiveData();
          break;
      }
    },
  );

  useEffect(() => {
    const command = eventConfig.command;

    if (!command) {
      return;
    }

    switch (command.type) {
      case "teams":
        setTeamsOpen(true);
        break;
      case "stream":
        setStreamsOpen(true);
        break;
      case "refresh":
        refreshLiveData();
        break;
    }

    controller.actions.clearEventViewCommand(event);
  }, [controller, event, eventConfig.command, refreshLiveData]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !==
        "r"
      ) {
        return;
      }

      const element =
        document.activeElement;

      if (
        [
          "INPUT",
          "TEXTAREA",
          "SELECT",
        ].includes(
          element?.tagName || "",
        )
      ) {
        return;
      }

      refreshLiveData();
    };

    window.addEventListener(
      "keydown",
      handler,
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handler,
      );
    };
  }, [refreshLiveData]);

  const setTrackedTeams = useCallback((teams: string[]) => {
    if (controller) {
      controller.actions.setEventViewTrackedTeams(event, teams);
    }
  }, [controller, event]);

  const toggleTeam = useCallback(
    (team: string) => {
      const next = trackedTeams.includes(team)
        ? trackedTeams.filter((value) => value !== team)
        : [...trackedTeams, team];
      setTrackedTeams(next);
    },
    [setTrackedTeams, trackedTeams],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-black text-sm text-neutral-500">
        Loading event…
      </div>
    );
  }

  if (error || !eventData) {
    return (
      <div className="flex h-full items-center justify-center bg-black text-center text-sm text-neutral-500">
        <div>
          <div className="font-semibold text-white">
            Event unavailable
          </div>

          <div className="mt-1">
            {event}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden bg-black">
      <div className="relative min-h-0 flex-1 flex overflow-hidden">
        <div className="relative min-w-0 min-h-0 flex-1">
          <StreamView
            stream={activeStream}
          />

          {!activeStream && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="rounded-xl border border-white/10 bg-neutral-950/90 px-5 py-4 text-center">
                <div className="font-semibold text-white">
                  No webcast available
                </div>

                <div className="mt-1 text-xs text-neutral-500">
                  This event has not published a
                  supported live stream.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="relative z-20 shrink-0">
        <MatchStrip
          matches={displayMatches}
          team={trackedTeams}
          nextMatch={nextMatch}
          lastMatch={lastMatch}
          eventTimezone={
            eventData.timezone
          }
          playoffAlliances={
            alliances
          }
          playoffType={
            eventData.playoff_type
          }
          eventName={
            eventData.short_name ||
            eventData.name
          }
          wssConnected={
            wssConnected
          }
          teamPills={teamPills}
          showEventInfo={true}
          isDivisional={
            isDivisional
          }
          multiview={{
            presentation:
              slotPresentation,
          }}
        />
      </footer>

      <StreamModal
        open={streamsOpen}
        onClose={() =>
          setStreamsOpen(false)
        }
        streams={streams}
        activeKey={activeKey}
        onSelect={(key) => controller?.actions.setEventViewStream(event, key)}
      />

      <TeamModal
        open={teamsOpen}
        onClose={() =>
          setTeamsOpen(false)
        }
        teams={teams}
        teamsStatuses={
          teamsStatuses
        }
        trackedTeams={
          trackedTeams
        }
        onToggle={toggleTeam}
      />
    </section>
  );
}