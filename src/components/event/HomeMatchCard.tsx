"use client";

import type { TBAMatch } from "@/lib/tba/types";
import NextMatchCountdown from "@/components/match/NextMatchCountdown";
import { formatTeamNumber, matchShortName, formatMatchEventTime } from "@/lib/tba/formatters";

type HomeMatchCardProps = {
  match: TBAMatch;
  eventTimezone?: string;
  isNext?: boolean;
};

export default function HomeMatchCard({ match, eventTimezone, isNext = false }: HomeMatchCardProps) {
  const redScore = match.alliances.red.score;
  const blueScore = match.alliances.blue.score;
  const hasResult = redScore != null && blueScore != null && redScore >= 0 && blueScore >= 0;
  const time = isNext && (match.predicted_time != null || match.time != null)
    ? <NextMatchCountdown nextMatch={match} eventTimezone={eventTimezone} />
    : match.actual_time != null
      ? formatMatchEventTime(match.actual_time, eventTimezone)
      : match.predicted_time != null
        ? formatMatchEventTime(match.predicted_time, eventTimezone)
        : match.time != null
          ? formatMatchEventTime(match.time, eventTimezone)
          : "Time TBD";

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/70 px-2.5 py-2">
      <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-2.5">
        <div className="flex min-w-0 flex-col justify-center border-r border-slate-200 pr-2">
          <span className="text-[10px] font-bold leading-tight text-slate-700">{matchShortName(match)}</span>
          <span className="mt-1 text-[9px] font-medium leading-tight tabular-nums text-slate-500">{time}</span>
        </div>
        <div className="min-w-0 space-y-1.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className={`min-w-0 truncate text-[11px] ${hasResult && redScore > blueScore ? "font-bold" : "font-medium"} text-red-600`}>
              {match.alliances.red.team_keys.map(formatTeamNumber).join(" · ")}
            </span>
            <span className={`shrink-0 font-mono text-[11px] tabular-nums ${hasResult && redScore > blueScore ? "font-bold text-red-700" : "font-medium text-slate-600"}`}>
              {redScore == null || redScore < 0 ? "—" : redScore}
            </span>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className={`min-w-0 truncate text-[11px] ${hasResult && blueScore > redScore ? "font-bold" : "font-medium"} text-blue-600`}>
              {match.alliances.blue.team_keys.map(formatTeamNumber).join(" · ")}
            </span>
            <span className={`shrink-0 font-mono text-[11px] tabular-nums ${hasResult && blueScore > redScore ? "font-bold text-blue-700" : "font-medium text-slate-600"}`}>
              {blueScore == null || blueScore < 0 ? "—" : blueScore}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
