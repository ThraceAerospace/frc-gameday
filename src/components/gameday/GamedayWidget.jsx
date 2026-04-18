"use client";

import { useEffect, useState } from "react";

import GamedayEventTeamInfo from "@/components/gameday/GamedayEventTeamInfo";
import StreamView from "@/components/gameday/StreamView";
import ChatView from "@/components/gameday/ChatView";
import StreamModal from "@/components/gameday/StreamModal";
import RefreshButton from "@/components/gameday/RefreshButton";
import MatchStrip from "@/components/gameday/navbar/MatchStrip";
import { VideoCameraIcon } from "@heroicons/react/24/solid";
import { UserGroupIcon } from "@heroicons/react/24/solid";
import { useGameday } from "@/components/gameday/hooks/useGameday";
import { useStreamController } from "@/components/gameday/hooks/useStreamController";
import { useActiveTeam } from "@/components/gameday/hooks/useActiveTeam";
import TeamModal from "@/components/gameday/teamElements/TeamModal";
import LastMatch from "@/components/gameday/teamElements/LastMatch";
import NextMatch from "@/components/gameday/teamElements/NextMatch";
export default function GamedayWidget({ event, team }) {
  const [activeTeam, setActiveTeam] = useState(team);
  const { data, loading, error, reload } = useGameday(event, activeTeam);

  const [streamModalOpen, setModalOpen] = useState(false);
  const [teamModalOpen, setTeamModalOpen] = useState(false);

  // ALWAYS normalize streams so hook never receives null/undefined
  const {
    streams,
    activeStream,
    activeKey,
    setActiveKey,
  } = useStreamController(data?.streams || [], data?.event?.timezone);

  // Debug only (safe now)
  useEffect(() => {
    //console.log("Active stream:", activeStream);
  }, [activeStream]);

  // Loading state
  if (loading && !data) {
    return (
      <div className="p-8 text-white">
        Loading gameday...
      </div>
    );
  }

  // Error state
  if (error || !data) {
    return (
      <div className="p-8 text-red-500">
        Failed to load gameday
      </div>
    );
  }

  return (
    <div className="w-full h-screen flex flex-col bg-black text-white overflow-hidden">

      {/* MAIN STREAM AREA */}
      <div className="flex-1 w-full flex flex-row overflow-hidden">

        {/* STREAM */}
        <div className="flex-1 relative bg-black">
          <StreamView stream={activeStream} />
        </div>

        {/* CHAT */}
        {/* <div className="hidden md:flex w-[320px] lg:w-[360px] border-l border-gray-800">
          <ChatView data={data} />
        </div> */}
      </div>

    {/* BOTTOM BAR */}
    <div className="w-full h-[8vh] min-h-fit bg-neutral-900 border-t border-neutral-700 flex flex-row items-center overflow-hidden">

      {/* LEFT (info) */}
      <div className="shrink-0">
        <GamedayEventTeamInfo data={data} />
      </div>

      {/* CENTER (MATCH STRIP CLIPPED ZONE) */}
      <div className="flex-1 min-w-0 overflow-hidden px-1">
        <div className="relative w-full overflow-hidden">

          {/* 1. Your actual scroll/strip content */}
          <div className="flex gap-1 w-full pt-1 pb-1 overflow-x-auto no-scrollbar">
            <LastMatch 
              match={data.lastMatch} 
              team={data.team}
              nextMatchKey={data.nextMatch?.key ?? null}
              eventTimezone={data.event.timezone}
              playoffAlliances={data.playoffAlliances}
              eventPlayoffType={data.event.playoff_type} />

            <NextMatch 
              match={data.nextMatch} 
              team={data.team} 
              playoffAlliances={data.playoffAlliances}
              eventPlayoffType={data.event.playoff_type}
              eventTimezone={data.event.timezone}
            />
            <MatchStrip
              matches={data.matches}
              team={activeTeam}
              nextMatchKey={data.nextMatch?.key ?? null}
              teamView={data.teamView}
              eventTimezone={data.event.timezone}
              playoffAlliances={data.playoffAlliances}
              eventPlayoffType={data.event.playoff_type}
            />
          </div>
          {/* 3. Right fade overlay */}
          <div className="pointer-events-none absolute right-0 top-0 h-full w-6 bg-gradient-to-l from-neutral-900 to-transparent" />

        </div>
      </div>

      {/* RIGHT (CONTROLS — ALWAYS VISIBLE) */}
      <div className="flex items-center gap-2 px-3 shrink-0">
        <button
          onClick={() => setTeamModalOpen(true)}
          className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
        >
          <UserGroupIcon className="w-4 h-5 text-white" />
        </button>

        <button
          onClick={() => setModalOpen(true)}
          className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
        >
          <VideoCameraIcon className="w-4 h-5 text-white" />
        </button>

        <RefreshButton onRefresh={reload} />
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
        teams={data.teams}
        activeTeam={activeTeam}
        setActiveTeam={setActiveTeam}
      />
    </div>
  );
}