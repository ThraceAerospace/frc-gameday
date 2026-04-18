"use client";

import Record from "@/components/gameday/teamElements/Record";
import EventInfo from "@/components/gameday/navbar/EventInfo";
import Rank from "@/components/gameday/teamElements/Rank";
import EventLocalTime from "@/components/gameday/navbar/EventLocalTime";

export default function GamedayEventTeamInfo({ data }) {
  const { event, team, nextMatch, lastMatch, matches, teamView } = data;

  const isTeamMode = teamView?.enabled && team;

  return (
    <div className="w-full h-full flex flex-row items-stretch gap-2 px-2 py-2 overflow-hidden">

      {/* LEFT */}
      <div className="flex flex-col justify-center shrink-0">
        {isTeamMode && (
          <div className="text-xs text-white">
            {team?.key ? team.key.replace("frc", "Team ") : ""} At
          </div>
        )}

        <EventInfo event={event} />

        {isTeamMode && (
          <div className="flex gap-1 text-nowrap">
            <Rank status={team?.status} team={team} />
            <Record status={team?.status} />
          </div>
        )}

        <div className={isTeamMode ? "[@media(hover:none)_and_(pointer:coarse)]:hidden" : ""} >
          <EventLocalTime timezone={data.event.timezone} />
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {/* <LastMatch 
          match={lastMatch} 
          team={team}
          nextMatchKey={data.nextMatch?.key ?? null}
          eventTimezone={data.event.timezone}
          playoffAlliances={data.playoffAlliances}
          eventPlayoffType={data.event.playoff_type} />

        <NextMatch 
          match={nextMatch} 
          team={team} 
          playoffAlliances={data.playoffAlliances}
          eventPlayoffType={data.event.playoff_type}
          eventTimezone={data.event.timezone}
        /> */}

      </div>      
    </div>
  );
}