"use client";
import GamedayBottomBar from "@/components/gameday/GamedayBottomBar";
import StreamView from "@/components/gameday/StreamView";
import ChatView from "@/components/gameday/ChatView";

import { useGameday } from "@/components/gameday/hooks/useGameday";

export default function GamedayWidget({ event, team }) {
  console.log("Rendering GamedayWidget with event", event, "team", team);
  const { data, loading, error } = useGameday(event, team);
  console.log("GamedayWidget data", data, "loading", loading, "error", error);

  if (loading) {
    return (
      <div className="p-8 text-white">
        Loading gameday...
      </div>
    );
  }

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
          <StreamView data={data} />
        </div>

        {/* CHAT */}
        <div className="hidden md:flex w-[320px] lg:w-[360px] border-l border-gray-800">
          <ChatView data={data} />
        </div>
      </div>

      {/* FIXED BOTTOM NAVBAR */}
      <div className="w-full h-[8vh] min-h-fit md:h-[6vh] bg-neutral-900 border-t border-neutral-700 flex flex-row">

        <GamedayBottomBar data={data} team={team} />
      </div>
    </div>
  );
}