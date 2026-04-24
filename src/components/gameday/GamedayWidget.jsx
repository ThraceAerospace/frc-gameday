"use client";

import { useEffect, useState, useMemo } from "react";

import GamedayEventTeamInfo from "@/components/gameday/GamedayEventTeamInfo";
import StreamView from "@/components/gameday/StreamView";
import ChatView from "@/components/gameday/ChatView";
import StreamModal from "@/components/gameday/StreamModal";
import RefreshButton from "@/components/gameday/RefreshButton";
import MatchStrip from "@/components/gameday/navbar/MatchStrip";

import { VideoCameraIcon } from "@heroicons/react/24/outline";
import { UserGroupIcon } from "@heroicons/react/24/outline";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";

import { useGameday } from "@/components/gameday/hooks/useGameday";
import { buildStreams } from "@/lib/gameday/buildStreams";
import { useStreamController } from "@/components/gameday/hooks/useStreamController";
import { useMatches } from "@/components/gameday/hooks/useMatches"
import { useEvent } from "@/components/gameday/hooks/useEvent"
import {useTeams} from "@/components/gameday/hooks/useTeams"
import { usePlayoffAlliances } from "@/components/gameday/hooks/usePlayoffAlliances"
import { useTrackedEvent } from "@/components/gameday/hooks/useTracking"
import { useTeamsStatuses } from "@/components/gameday/hooks/useTeamsStatuses";

import TeamModal from "@/components/gameday/teamElements/TeamModal";
import LastMatch from "@/components/gameday/teamElements/LastMatch";
import NextMatch from "@/components/gameday/teamElements/NextMatch";

export default function GamedayWidget({ event, team, isDivisional }) {
  const {event:eventData} = useEvent(event);

  const {teams: teams} = useTeams(event);
  const {teamsStatuses: teamStatuses} = useTeamsStatuses(event);
  const [activeTeam, setActiveTeam] = useState(team);
  
  const { matches } = useMatches(event, activeTeam ? [activeTeam] : []);

  const {alliances: playoffAlliances} = usePlayoffAlliances(event);

  const trackedTeams = useMemo(() => {
    return activeTeam ? [activeTeam] : [];
  }, [activeTeam]);

  const {
    trackedMatches,
    eventNextMatch,
    eventLastMatch,
    trackedNextMatch,
    trackedLastMatch,
  } = useTrackedEvent(matches, trackedTeams);

  const matchContext = activeTeam
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

  const [streamModalOpen, setModalOpen] = useState(false);
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  const [rawStreams, setStreams] = useState([]); 
  useEffect(() => { 
    let cancelled = false; 
    async function loadStreams() { 
      if (!eventData?.webcasts) 
        return; const built = await buildStreams(eventData.webcasts); 
      if (!cancelled) { 
        setStreams(built); 
      } 
    } 
    loadStreams();
     return () => { cancelled = true; }; 
  }, [eventData?.webcasts]);

  const { streams: streams, activeStream, activeKey, setActiveKey, } = useStreamController(rawStreams || [], eventData?.timezone);
  // Debug only (safe now)
  useEffect(() => {
    //console.log("Active stream:", activeStream);
  }, [activeStream]);

  // Loading state
  if (!eventData) {
    return (
      <div className="p-8 text-white">
        Loading gameday...
      </div>
    );
  }


  return (
    <div className="w-full h-full flex flex-col bg-black text-white overflow-hidden">

      {/* MAIN STREAM AREA */}
      <div className="flex-1 w-full flex flex-row overflow-hidden">

        {/* STREAM */}
        <div className="flex-1 relative bg-black">
          <StreamView stream={activeStream} />
        </div>

        {/* CHAT */}
        <div
          className={`w-80 border-l border-neutral-800 transition-transform duration-200 ${
            chatOpen ? "translate-x-0" : "translate-x-full hidden"
          }`}
        >
          <ChatView stream={activeStream} />
        </div>
      </div>

    {/* BOTTOM BAR */}
    <div className="w-full h-[8vh] min-h-fit bg-neutral-900 border-t border-neutral-700 flex flex-row items-center overflow-hidden">

      {/* LEFT (info) */}
      <div className="shrink-0">
        <GamedayEventTeamInfo event={eventData} team={activeTeam} teamStatus={teamStatuses[activeTeam]} isDivisional={isDivisional} />
      </div>

      {/* CENTER (MATCH STRIP CLIPPED ZONE) */}
      <div className="flex-1 min-w-0 overflow-hidden px-1">
        <div className="relative w-full overflow-hidden">

          {/* 1. Your actual scroll/strip content */}
          <div className="flex gap-1 w-full pt-1 pb-1 overflow-x-auto no-scrollbar">
            {/* <LastMatch
              match={matchContext.last}
              team={activeTeam}
              eventTimezone={eventData?.timezone}
              playoffAlliances={playoffAlliances}
              nextMatchKey={matchContext.next?.key}
              eventLastMatch={matchContext.last}
            />

            <NextMatch
              match={matchContext.next}
              team={activeTeam}
              isNext={true}
              eventTimezone={eventData?.timezone}
              playoffAlliances={playoffAlliances}
              nextMatchKey={matchContext.next?.key}
              eventLastMatch={matchContext.last}
            /> */}
            <MatchStrip
              matches={matchContext.list}
              nextMatchKey={matchContext.next?.key}
              lastMatchKey={matchContext.last}
              eventPlayoffType={eventData.playoff_type}
              playoffAlliances={playoffAlliances}
              eventTimezone={eventData?.timezone}
            />
          </div>
          {/* 3. Right fade overlay */}
          <div className="pointer-events-none absolute right-0 top-0 h-full w-6 bg-gradient-to-l from-neutral-900 to-transparent" />

        </div>
      </div>

      {/* RIGHT (CONTROLS — ALWAYS VISIBLE) */}
          <div className="grid grid-cols-2 gap-2 px-3 shrink-0">
            <button
              onClick={() => setTeamModalOpen(true)}
              className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
            >
              <UserGroupIcon className="w-4 h-5 text-white" />
            </button>
            
            <RefreshButton onRefresh={null} />

            <button
              onClick={() => setModalOpen(true)}
              className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
            >
              <VideoCameraIcon className="w-4 h-5 text-white" />
            </button>
            <button
              onClick={() => setChatOpen(prev => !prev)}
              className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
            >
              <ChatBubbleLeftRightIcon className="w-4 h-5 text-white" />
            </button>
          </div>
      </div>

      {/* STREAM MODAL */}
      <StreamModal
        open={streamModalOpen}
        setOpen={setModalOpen}
        streams={streams}
        activeKey={activeKey}
        setActiveKey={setActiveKey}
      />

      <TeamModal
        open={teamModalOpen}
        setOpen={setTeamModalOpen}
        teams={teams}
        playoffAlliances={playoffAlliances}
        activeTeam={activeTeam}
        setActiveTeam={setActiveTeam}
      />
    </div>
  );
}