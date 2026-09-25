"use client";

import type { ReactNode } from "react";
import type { TBAMatch } from "@/lib/tba/types";
import type { BuiltStream } from "@/lib/gameday/buildStreams";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ArrowPathIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  UserGroupIcon,
  VideoCameraIcon,
} from "@heroicons/react/24/outline";
import StreamView from "./StreamView";
import ChatView from "./ChatView";
import StreamModal from "./StreamModal";
import TeamModal from "./team/TeamModal";
import TeamPill from "./team/TeamPill";
import MatchStrip from "./match/MatchStrip";
import { buildStreams } from "@/lib/gameday/buildStreams";
import { useEvent } from "./hooks/useEvent";
import { useTeams } from "./hooks/useTeams";
import { useTeamsStatuses } from "./hooks/useTeamsStatuses";
import { usePlayoffAlliances } from "./hooks/usePlayoffAlliances";
import { useMatches } from "./hooks/useMatches";
import { useTrackedMatches } from "./hooks/useTrackedMatches";
import { useStreamController } from "./hooks/useStreamController";
import { useWebSocket } from "./hooks/useWebSocket";
import { useMatchImminence } from "../multiview/hooks/useMatchImminence";

const EMPTY_TEAMS = [];

type MatchImminentSignal = { type: "match_imminent"; matchKey: string; severity: "hard" | "soft" };

type GamedayWidgetProps = { event: string; initialTeams?: string[]; registerLabel?: (label: string) => void; onMatchImminent?: (signal: MatchImminentSignal) => void; isDivisional?: boolean; multiview?: { presentation?: { teamTracker?: "visible" | "hidden"; matchInfo?: "visible" | "hidden" } } };

const DEFAULT_PRESENTATION = {
  teamTracker: "visible",
  matchInfo: "visible",
};

export default function GamedayWidget({
  event,
  initialTeams = EMPTY_TEAMS,
  registerLabel,
  onMatchImminent,
  isDivisional = false,
  multiview = {},
}: GamedayWidgetProps) {
  
const {
  event: eventData,
  loading,
  error,
  reloadEvent,
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

  const [trackedTeams, setTrackedTeams] =
    useState(initialTeams);

  const [streamsRaw, setStreamsRaw] =
    useState<BuiltStream[]>([]);

  const [settingsOpen, setSettingsOpen] =
    useState(false);

const [teamsOpen, setTeamsOpen] =
    useState(false);

  const [streamsOpen, setStreamsOpen] =
    useState(false);

  const [chatOpen, setChatOpen] =
    useState(false);

  useEffect(() => {
    setTrackedTeams(initialTeams);
  }, [initialTeams]);

  const eventLabel =
    eventData?.short_name ||
    eventData?.name ||
    eventData?.key;

  useEffect(() => {
    if (eventLabel) {
      registerLabel?.(eventLabel);
    }
  }, [eventLabel, registerLabel]);

  useEffect(() => {
    let cancelled = false;

    if (!eventData?.webcasts) {
      setStreamsRaw([]);
      return;
    }

    buildStreams(
      eventData.webcasts,
    ).then((streams) => {
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
        onMatchImminent?.(signal);
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

  const slotPresentation =
    multiview.presentation ??
    DEFAULT_PRESENTATION;

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

  /*
   * WebSocket notifications are invalidation
   * signals. The socket is scoped to this event,
   * so a received event means the existing TBA
   * data sources should be refreshed.
   */
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

      console.log(
        `[WSS] Received ${message.messageType} for event ${message.eventKey}`,
      );

      switch (message.messageType) {
        case "upcoming_match":
        case "match_score":
        case "match_video":
          console.log(
            "[WSS] Reloading Matches and Team Statuses...",
          );
          void reloadMatches();
          void reloadStatuses();
          break;

        case "starting_comp_level":
        case "schedule_updated":
          console.log(
            "[WSS] Full refresh triggered...",
          );
          refreshLiveData();
          break;

        case "alliance_selection":
          console.log(
            "[WSS] Reloading Playoff Alliances and Team Statuses...",
          );
          void reloadAlliances();
          void reloadStatuses();
          void reloadMatches();
          break;

        default:
          console.log(
            `[WSS] Unknown message type "${message.messageType}", refreshing all data sources`,
          );
          refreshLiveData();
          break;
      }
    },
  );

  useEffect(() => {
    const handler = (event) => {
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

  const toggleTeam = useCallback(
    (team) =>
      setTrackedTeams(
        (current) =>
          current.includes(team)
            ? current.filter(
                (value) =>
                  value !== team,
              )
            : [
                ...current,
                team,
              ],
      ),
    [],
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
      <div className="absolute left-2 top-2 z-50">
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={() =>
            setSettingsOpen(
              (value) => !value,
            )
          }
          className={`icon-button rounded-md border border-white/10 bg-neutral-950/85 shadow-lg backdrop-blur ${
            settingsOpen
              ? "active"
              : ""
          }`}
        >
          <Cog6ToothIcon />
        </button>

        {settingsOpen && (
          <div className="absolute left-0 top-full mt-1 flex flex-col gap-1 rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-xl">
<button
              className={`icon-button ${
                trackedTeams.length
                  ? "active"
                  : ""
              }`}
              title="Track teams"
              onClick={() =>
                setTeamsOpen(true)
              }
            >
              <UserGroupIcon />
            </button>

            <button
              className="icon-button"
              title="Choose webcast"
              onClick={() =>
                setStreamsOpen(true)
              }
            >
              <VideoCameraIcon />
            </button>

            <button
              className={`icon-button ${
                chatOpen
                  ? "active"
                  : ""
              }`}
              title="Open chat"
              onClick={() =>
                setChatOpen(
                  (value) => !value,
                )
              }
            >
              <ChatBubbleLeftRightIcon />
            </button>

            <button
              className="icon-button"
              title="Refresh live data"
              onClick={
                refreshLiveData
              }
            >
              <ArrowPathIcon />
            </button>
          </div>
        )}
      </div>

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

        {chatOpen && (
          <aside className="h-full w-[min(420px,92vw)] shrink-0 border-l border-white/10 bg-black shadow-2xl">
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-xs font-semibold">
                <span>
                  Live chat
                </span>

                <button
                  onClick={() =>
                    setChatOpen(false)
                  }
                  className="text-neutral-500"
                >
                  Close
                </button>
              </div>

              <div className="min-h-0 flex-1">
                <ChatView
                  stream={activeStream}
                />
              </div>
            </div>
          </aside>
        )}
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
        onSelect={setActiveKey}
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