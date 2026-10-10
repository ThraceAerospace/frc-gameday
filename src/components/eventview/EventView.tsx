"use client";

import {
  useCallback,
  useEffect,
  useState,
} from "react";


import StreamView from "./StreamView";
import StreamModal from "./StreamModal";
import TeamModal from "@/components/team/TeamModal";
import TeamPill from "@/components/team/TeamPill";
import EventFooter from "@/components/event/EventFooter";
import { buildStreams } from "@/lib/tba/buildStreams";
import { useEventState } from "@/lib/events";
import type { BuiltStream } from "@/lib/tba/buildStreams";


import { useTrackedMatches } from "./hooks/useTrackedMatches";
import { useStreamController } from "./hooks/useStreamController";
import { useUpcomingMatchAlert } from "../surface/hooks/useUpcomingMatchAlert";
import type { TileSurfaceController } from "../surface/TileSurfaceActions";
import type { EventViewConfig } from "./EventViewConfig";

type EventViewProps = {
  event: string;
  config: EventViewConfig;
  controller: TileSurfaceController;
  isDivisional?: boolean;
  slotPresentation?: {
    teamTracker: "visible" | "hidden";
    matchInfo: "visible" | "hidden";
    footerHidden?: boolean;
  };
  priorityEditing?: boolean;
  activeHighlighted?: boolean;
  imminentMatch?: boolean;
  upcomingMatchKey?: string | null;
  onToggleActive?: () => void;
  slotNumber?: number;
  controlHeld?: boolean;
};

export default function EventView({
  event,
  config,
  controller,
  isDivisional = false,
  slotPresentation,
  priorityEditing = false,
  activeHighlighted = false,
  imminentMatch = false,
  upcomingMatchKey = null,
  onToggleActive,
  slotNumber,
  controlHeld = false,
}: EventViewProps) {
  const {
    state: eventState,
    event: eventData,
    teams,
    matches,
    eventNextMatch,
    eventLastMatch,
    teamsStatuses,
    alliances,
    loading,
    error,
    websocketStatus,
    websocketStale: webSocketStale,
  } = useEventState(event);


  const eventStateSnapshot = eventState?.getSnapshot() ?? null;

  const eventConfig = config;
  const footerMode = eventConfig.footerMode;
  const footerHidden = slotPresentation?.footerHidden ?? false;
  const trackedTeams = eventConfig.trackedTeams;
  const selectedStreamKey = eventConfig.selectedStream;

  const [streamsRaw, setStreamsRaw] =
    useState<BuiltStream[]>([]);
  const [streamReloadKey, setStreamReloadKey] = useState(0);

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
  } = useStreamController(
    streamsRaw,
    eventData?.timezone,
    selectedStreamKey,
  );

  const { trackedNextMatches } = useTrackedMatches(matches, trackedTeams);

  // Team tracking highlights relevant matches but never hides the event schedule.
  const nextMatch = eventNextMatch;
  const lastMatch = eventLastMatch;
  const displayMatches = matches;

  useUpcomingMatchAlert({
    eventKey: event,
    eventState: eventStateSnapshot,
    trackedTeams,
    autoHighlight: eventConfig.autoHighlight,
    actions: controller.actions,
  });

  const teamPills = trackedTeams.map((team) => (
    <TeamPill
      key={team}
      team={team}
      status={teamsStatuses[team]}
      nextMatch={trackedNextMatches[team]}
      playoffAlliances={alliances}
      eventTimezone={eventData?.timezone}
      playoffType={eventData?.playoff_type}
    />
  ));

  const presentation = eventConfig.presentation;

  const refreshLiveData = useCallback(() => {
    eventState?.reloadAlliances();
    eventState?.reloadMatches();
    eventState?.reloadStatuses();
  }, [eventState]);

  const wssConnected = websocketStatus === "connected";

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
      case "reloadStream":
        setStreamReloadKey((value) => value + 1);
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
    controller.actions.setEventViewTrackedTeams(event, teams);
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
            reloadKey={streamReloadKey}
            muted={eventConfig.streamMuted}
            volume={eventConfig.streamVolume}
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

      <EventFooter
        mode={footerMode}
        eventName={eventData.short_name || eventData.name}
        eventTimezone={eventData.timezone}
        isDivisional={isDivisional}
        wssConnected={wssConnected}
        wssStale={webSocketStale}
        multiviewHidden={footerHidden}
        matches={displayMatches}
        team={trackedTeams}
        nextMatch={nextMatch}
        lastMatch={lastMatch}
        playoffAlliances={alliances}
        playoffType={eventData.playoff_type}
        teamsStatuses={teamsStatuses}
        teamPills={teamPills}
        multiview={{ presentation }}
        priorityEditing={priorityEditing}
        activeHighlighted={activeHighlighted}
        imminentMatch={imminentMatch}
        onToggleActive={onToggleActive}
        slotNumber={slotNumber}
        controlHeld={controlHeld}
      />

      <StreamModal
        open={streamsOpen}
        onClose={() =>
          setStreamsOpen(false)
        }
        streams={streams}
        activeKey={activeKey}
        onSelect={(key) => controller.actions.setEventViewStream(event, key)}
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