"use client";

import Record from "@/components/gameday/teamElements/Record";
import EventInfo from "@/components/gameday/navbar/EventInfo";
import Rank from "@/components/gameday/teamElements/Rank";
import EventLocalTime from "@/components/gameday/navbar/EventLocalTime";

export default function GamedayEventTeamInfo({ event, team: teamKey, teamStatus, isDivisional }) {
  const isTeamMode = teamKey && teamStatus;
  return (
    <div className="w-full h-full flex flex-row items-stretch gap-2 px-2 py-2 overflow-hidden">

      {/* LEFT */}
      <div className="flex flex-col justify-center shrink-0">
        {isTeamMode && (
          <div className="text-xs text-white">
            {teamKey ? teamKey.replace("frc", "Team ") : ""} At
          </div>
        )}

        <EventInfo event={event} />

        {isTeamMode && (
          <div className="flex gap-1 text-nowrap">
            <Rank status={teamStatus} team={teamKey} />
            <Record status={teamStatus} />
          </div>
        )}

        <div className={`text-xs text-gray-400 ${isTeamMode ? "[@media(hover:none)_and_(pointer:coarse)]:hidden" : ""}`}>
          {!isDivisional && <EventLocalTime timezone={event?.timezone} />}
        </div>
      </div>  
    </div>
  );
}