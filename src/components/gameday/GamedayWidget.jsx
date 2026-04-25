"use client";

import { useEffect, useState } from "react";

import GamedayEventTeamInfo from "@/components/gameday/GamedayEventTeamInfo";
import StreamView from "@/components/gameday/StreamView";
import ChatView from "@/components/gameday/ChatView";
import StreamModal from "@/components/gameday/StreamModal";
import RefreshButton from "@/components/gameday/RefreshButton";
import MatchStrip from "@/components/gameday/navbar/MatchStrip";

import {
  VideoCameraIcon,
  UserGroupIcon,
  ChatBubbleLeftRightIcon,
} from "@heroicons/react/24/outline";

import { buildStreams } from "@/lib/gameday/buildStreams";

import { useStreamController } from "@/components/gameday/hooks/useStreamController";
import { useMatches } from "@/components/gameday/hooks/useMatches";
import { useEvent } from "@/components/gameday/hooks/useEvent";
import { useTeams } from "@/components/gameday/hooks/useTeams";
import { usePlayoffAlliances } from "@/components/gameday/hooks/usePlayoffAlliances";
import { useTrackedEvent } from "@/components/gameday/hooks/useTracking";
import { useTeamsStatuses } from "@/components/gameday/hooks/useTeamsStatuses";

import TeamModal from "@/components/gameday/teamElements/TeamModal";

export default function GamedayWidget({
  event,
  initialTeams = [],
  registerLabel,
  isDivisional,
}) {
  // ==============================
  // CORE DATA
  // ==============================
  const { event: eventData } = useEvent(event);
  const { teams } = useTeams(event);
  const { teamsStatuses, reload: reloadStatuses } = useTeamsStatuses(event);
  const { matches, reload: reloadMatches } = useMatches(event);
  const { alliances: playoffAlliances, reload: reloadAlliances } =
    usePlayoffAlliances(event);

  // ==============================
  // REPORT LABEL TO PARENT
  // ==============================
  useEffect(() => {
    if (eventData?.short_name && registerLabel) {
      registerLabel(eventData.short_name);
    }
  }, [eventData?.short_name, registerLabel]);

  // ==============================
  // TRACKED TEAMS
  // ==============================
  const [trackedTeams, setTrackedTeams] = useState(initialTeams);

  function addTrackedTeam(teamKey) {
    setTrackedTeams((prev) => [...prev, teamKey]);
  }

  function removeTrackedTeam(teamKey) {
    setTrackedTeams((prev) => prev.filter((t) => t !== teamKey));
  }

  // ==============================
  // MATCH CONTEXT
  // ==============================
  const {
    trackedMatches,
    eventNextMatch,
    eventLastMatch,
    trackedNextMatch,
    trackedLastMatch,
  } = useTrackedEvent(matches, trackedTeams);

  const matchContext =
    trackedTeams.length > 0
      ? {
          list: trackedMatches,
          next: trackedNextMatch,
          last: trackedLastMatch,
        }
      : {
          list: matches,
          next: eventNextMatch,
          last: eventLastMatch,
        };

  // ==============================
  // STREAMS
  // ==============================
  const [rawStreams, setRawStreams] = useState([]);

  useEffect(() => {
    let cancelled = false;

    async function loadStreams() {
      if (!eventData?.webcasts) return;

      const built = await buildStreams(eventData.webcasts);
      if (!cancelled) setRawStreams(built);
    }

    loadStreams();
    return () => {
      cancelled = true;
    };
  }, [eventData?.webcasts]);

  const {
    streams,
    activeStream,
    activeKey,
    setActiveKey,
  } = useStreamController(rawStreams, eventData?.timezone);

  // ==============================
  // UI STATE
  // ==============================
  const [streamModalOpen, setStreamModalOpen] = useState(false);
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  // R to refresh
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "r") reloadDataSources();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reloadDataSources]);

  // ==============================
  // LOADING STATE
  // ==============================
  if (!eventData) {
    return (
      <div className="p-8 text-white">
        Loading gameday...
      </div>
    );
  }

  // ==============================
  // RELOAD
  // ==============================
  function reloadDataSources() {
    reloadMatches();
    reloadAlliances();
    reloadStatuses();
  }

  // ==============================
  // RENDER
  // ==============================
  return (
    <div className="w-full h-full flex flex-col bg-black text-white overflow-hidden">
      {/* MAIN */}
      <div className="flex-1 flex flex-row overflow-hidden">
        {/* STREAM */}
        <div className="flex-1 bg-black">
          <StreamView stream={activeStream} />
        </div>

        {/* CHAT */}
        <div
          className={`w-80 border-l border-neutral-800 transition-all duration-200 ${
            chatOpen ? "block" : "hidden"
          }`}
        >
          <ChatView stream={activeStream} />
        </div>
      </div>

      {/* BOTTOM BAR */}
      <div className="w-full h-[8vh] min-h-fit bg-neutral-900 border-t border-neutral-700 flex items-center">
        {/* LEFT */}
        <div className="shrink-0">
          <GamedayEventTeamInfo
            event={eventData}
            team={trackedTeams}
            teamStatus={teamsStatuses}
            nextMatch={matchContext.next}
            lastMatch={matchContext.last}
            isDivisional={isDivisional}
          />
        </div>

        {/* CENTER */}
        <div className="flex-1 min-w-0 overflow-hidden px-1">
          <div className="flex gap-1 overflow-x-auto no-scrollbar py-1">
            <MatchStrip
              matches={matchContext.list}
              nextMatchKey={matchContext.next}
              lastMatchKey={matchContext.last}
              eventPlayoffType={eventData.playoff_type}
              playoffAlliances={playoffAlliances}
              eventTimezone={eventData?.timezone}
              team={trackedTeams}
            />
          </div>
        </div>

        {/* RIGHT CONTROLS */}
        <div className="grid grid-cols-2 gap-2 px-3 shrink-0">
          <button
            onClick={() => setTeamModalOpen(true)}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
          >
            <UserGroupIcon className="w-4 h-5" />
          </button>

          <RefreshButton onRefresh={reloadDataSources} />

          <button
            onClick={() => setStreamModalOpen(true)}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
          >
            <VideoCameraIcon className="w-4 h-5" />
          </button>

          <button
            onClick={() => setChatOpen((prev) => !prev)}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
          >
            <ChatBubbleLeftRightIcon className="w-4 h-5" />
          </button>
        </div>
      </div>

      {/* MODALS */}
      <StreamModal
        open={streamModalOpen}
        setOpen={setStreamModalOpen}
        streams={streams}
        activeKey={activeKey}
        setActiveKey={setActiveKey}
      />

      <TeamModal
        open={teamModalOpen}
        setOpen={setTeamModalOpen}
        teams={teams}
        teamsStatuses={teamsStatuses}
        playoffAlliances={playoffAlliances}
        activeTeam={trackedTeams}
        addTrackedTeam={addTrackedTeam}
        removeTrackedTeam={removeTrackedTeam}
      />
    </div>
  );
}