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
          : null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-slate-700">{matchShortName(match)}</span>
        {time ? <span className="text-[10px] font-medium tabular-nums text-slate-500">{time}</span> : null}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-sm bg-red-500" />
            <span className="truncate text-xs font-medium text-slate-700">
              {match.alliances.red.team_keys.map(formatTeamNumber).join(" · ")}
            </span>
          </div>
          <span className={`font-mono text-xs tabular-nums ${hasResult && redScore > blueScore ? "font-bold text-slate-950" : "text-slate-600"}`}>
            {redScore == null || redScore < 0 ? "—" : redScore}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-sm bg-blue-500" />
            <span className="truncate text-xs font-medium text-slate-700">
              {match.alliances.blue.team_keys.map(formatTeamNumber).join(" · ")}
            </span>
          </div>
          <span className={`font-mono text-xs tabular-nums ${hasResult && blueScore > redScore ? "font-bold text-slate-950" : "text-slate-600"}`}>
            {blueScore == null || blueScore < 0 ? "—" : blueScore}
          </span>
        </div>
      </div>
    </div>
  );
}
