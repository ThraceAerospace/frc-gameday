"use client";

import { useEffect, useState, useRef } from "react";

import GamedayEventTeamInfo from "@/components/gameday/GamedayEventTeamInfo";
import StreamView from "@/components/gameday/StreamView";
import ChatView from "@/components/gameday/ChatView";
import StreamModal from "@/components/gameday/StreamModal";
import MatchStrip from "@/components/gameday/navbar/MatchStrip";

import {
  VideoCameraIcon,
  UserGroupIcon,
  ArrowPathIcon,
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
import { refresh } from "next/cache";

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
  const { alliances: playoffAlliances, reload: reloadAlliances } = usePlayoffAlliances(event);

  // ==============================
  // REPORT LABEL TO PARENT
  // ==============================
  useEffect(() => {
    if (eventData && registerLabel) {
      registerLabel(eventData?.short_name || eventData?.name || eventData?.key);
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
  const [controlsVisible, setControlsVisible] = useState(false);
  const controlsRef = useRef(null);

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
          className={`w-[15vw] border-l border-neutral-800 transition-all duration-200 ${
            chatOpen ? "flex" : "hidden"
          }`}
        >
          <ChatView stream={activeStream} />
        </div>
      </div>

      {/* BOTTOM BAR */}
      <div
        className="w-full h-[clamp(48px,6vh,72px)] bg-neutral-900 border-t border-neutral-700 flex items-center overflow-hidden"
        onMouseEnter={() => setControlsVisible(true)}
        onMouseLeave={() => setControlsVisible(false)}
      >
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
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden px-1 h-full flex items-center relative">

          {/* SCROLL AREA */}
          <div className="flex gap-1 overflow-x-auto no-scrollbar h-full items-center">
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

          {/* RIGHT FADE (NOW CORRECTLY CONSTRAINED TO BAR HEIGHT) */}
          <div className="pointer-events-none absolute right-0 top-0 h-full w-10 bg-gradient-to-l from-neutral-900 to-transparent" />
        </div>
  

        {/* RIGHT CONTROLS */}
        <div
          ref={controlsRef}
          className={`
            overflow-hidden shrink-0
            transition-all duration-300
            ${controlsVisible ? "w-[180px] opacity-100 ml-2" : "w-0 opacity-0 ml-0"}
          `}
        >
          <div className="flex gap-2 px-2">
            <button
              onClick={() => setTeamModalOpen(true)}
              className="p-2 bg-neutral-800/80 hover:bg-neutral-700 rounded"
            >
              <UserGroupIcon className="w-4 h-5" />
            </button>

            <button
              onClick={reloadDataSources}
              className="p-2 bg-neutral-800/80 hover:bg-neutral-700 rounded"
            >
              <ArrowPathIcon className="w-4 h-5" />
            </button>

            <button
              onClick={() => setStreamModalOpen(true)}
              className="p-2 bg-neutral-800/80 hover:bg-neutral-700 rounded"
            >
              <VideoCameraIcon className="w-4 h-5" />
            </button>

            <button
              onClick={() => setChatOpen((prev) => !prev)}
              className="p-2 bg-neutral-800/80 hover:bg-neutral-700 rounded"
            >
              <ChatBubbleLeftRightIcon className="w-4 h-5" />
            </button>
          </div>
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