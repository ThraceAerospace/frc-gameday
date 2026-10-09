"use client";

import { useMemo } from "react";
import { useEventState } from "@/lib/events";
import type { EventStateSnapshot } from "@/lib/events/EventState";
import type { TBAMatch } from "@/lib/tba/types";
import { formatTeamNumber } from "@/lib/tba/formatters";

type AllianceColor = "red" | "blue";

function matchLabel(match: TBAMatch | null) {
  if (!match) return "Waiting for next match";
  const level = match.comp_level?.toUpperCase();
  if (level === "qm") return `Qualification ${match.match_number}`;
  if (level === "ef") return `Octofinal ${match.set_number}-${match.match_number}`;
  if (level === "qf") return `Quarterfinal ${match.set_number}-${match.match_number}`;
  if (level === "sf") return `Semifinal ${match.set_number}-${match.match_number}`;
  if (level === "f") return `Final ${match.set_number}-${match.match_number}`;
  return match.key;
}

function AllianceCard({
  color,
  match,
  snapshot,
  trackedTeams,
}: {
  color: AllianceColor;
  match: TBAMatch;
  snapshot: EventStateSnapshot;
  trackedTeams: string[];
}) {
  const alliance = match.alliances[color];
  const teamNames = useMemo(
    () => new Map(snapshot.teams.map((team) => [team.key, team.nickname ?? team.name ?? team.key])),
    [snapshot.teams],
  );
  const scorePosted = typeof alliance.score === "number" && alliance.score >= 0;
  const winner = match.winning_alliance === color;
  const tied = match.winning_alliance === "";

  return (
    <section className={`min-w-0 overflow-hidden rounded-2xl border ${color === "red" ? "border-red-400/30 bg-red-950/20" : "border-blue-400/30 bg-blue-950/20"}`}>
      <header className={`flex items-center justify-between border-b px-4 py-3 ${color === "red" ? "border-red-400/20" : "border-blue-400/20"}`}>
        <span className={`text-xs font-bold uppercase tracking-[0.18em] ${color === "red" ? "text-red-300" : "text-blue-300"}`}>{color} alliance</span>
        <span className="text-2xl font-semibold tabular-nums text-white">{scorePosted ? alliance.score : "—"}</span>
      </header>
      <div className="divide-y divide-white/5">
        {(alliance.team_keys ?? []).map((teamKey) => {
          const tracked = trackedTeams.includes(teamKey);
          return (
            <div key={teamKey} className={`flex items-center gap-3 px-4 py-3 ${tracked ? "bg-amber-300/[0.08]" : ""}`}>
              <span className={`min-w-12 font-mono text-sm font-bold tabular-nums ${tracked ? "text-amber-200 underline decoration-amber-400 decoration-2 underline-offset-4" : "text-white"}`}>{formatTeamNumber(teamKey)}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-300">{teamNames.get(teamKey) ?? teamKey}</span>
              {tracked ? <span className="rounded-full border border-amber-300/30 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-200">Tracked</span> : null}
            </div>
          );
        })}
      </div>
      {scorePosted && match.score_breakdown?.[color] ? (
        <div className="border-t border-white/10 px-4 py-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">Official score breakdown</div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {Object.entries(match.score_breakdown[color] as Record<string, unknown>)
              .filter(([, value]) => typeof value === "number" || typeof value === "string")
              .map(([label, value]) => (
                <div key={label} className="flex min-w-0 items-baseline justify-between gap-2">
                  <dt className="truncate text-neutral-500">{label.replaceAll("_", " ")}</dt>
                  <dd className="shrink-0 font-mono tabular-nums text-neutral-200">{String(value)}</dd>
                </div>
              ))}
          </dl>
        </div>
      ) : null}
      {scorePosted && (winner || tied) ? (
        <footer className="border-t border-white/10 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
          {tied ? "Official result: tie" : winner ? "Official winner" : "Final score"}
        </footer>
      ) : null}
    </section>
  );
}

export function MatchInsightsContent({
  eventKey,
  snapshot,
  trackedTeams = [],
}: {
  eventKey: string;
  snapshot: EventStateSnapshot;
  trackedTeams?: string[];
}) {
  const { event, eventNextMatch, eventLastMatch, loading, error, oprs } = snapshot;
  const match = eventNextMatch;
  const isPostMatch = Boolean(!match && eventLastMatch && eventLastMatch.alliances.red.score >= 0 && eventLastMatch.alliances.blue.score >= 0);
  const displayMatch = match ?? (isPostMatch ? eventLastMatch : null);
  const eventTitle = event?.short_name || event?.name || eventKey;

  const statistics = useMemo(() => {
    if (!displayMatch || !oprs) return null;
    const collect = (color: AllianceColor) => (displayMatch.alliances[color].team_keys ?? []).map((teamKey) => ({
      teamKey,
      opr: oprs.oprs?.[teamKey],
      dpr: oprs.dprs?.[teamKey],
      ccwm: oprs.ccwms?.[teamKey],
    }));
    return { red: collect("red"), blue: collect("blue") };
  }, [displayMatch, oprs]);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[#07090d] text-white">
      <header className="shrink-0 border-b border-white/10 bg-neutral-950/80 px-5 py-4 sm:px-7">
        <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-neutral-500">FieldView · Match Insights</div>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold sm:text-xl">{eventTitle}</h1>
          <span className="text-xs text-neutral-500">{displayMatch ? matchLabel(displayMatch) : "No match selected"}</span>
        </div>
      </header>

      {error ? <div className="mx-5 mt-4 rounded-lg border border-red-400/20 bg-red-950/30 p-3 text-sm text-red-200">Event data is temporarily unavailable.</div> : null}

      {!displayMatch ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
          <div>
            <div className="text-base font-semibold text-neutral-200">{loading ? "Loading event and match data…" : "No upcoming match"}</div>
            <p className="mt-2 max-w-md text-sm leading-6 text-neutral-500">Match Insights follows the event schedule, not the tracked-team list. It will update when EventState identifies the next match.</p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
          {isPostMatch ? <div className="mb-4 rounded-lg border border-emerald-400/20 bg-emerald-950/20 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-emerald-200">Official result available</div> : null}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <AllianceCard color="red" match={displayMatch} snapshot={snapshot} trackedTeams={trackedTeams} />
            <AllianceCard color="blue" match={displayMatch} snapshot={snapshot} trackedTeams={trackedTeams} />
          </div>
          <section className="mt-4 rounded-2xl border border-white/10 bg-neutral-950/60 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Team performance estimates</h2>
              <span className="text-[10px] uppercase tracking-widest text-neutral-500">The Blue Alliance · OPR / DPR / CCWM</span>
            </div>
            {statistics ? (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {(["red", "blue"] as const).map((color) => (
                  <div key={color}>
                    <div className={`mb-2 text-xs font-bold uppercase tracking-wider ${color === "red" ? "text-red-300" : "text-blue-300"}`}>{color} alliance</div>
                    <div className="space-y-2">
                      {statistics[color].map((team) => (
                        <div key={team.teamKey} className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(3.5rem,auto))] items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2 text-xs">
                          <span className={`truncate font-mono font-semibold ${trackedTeams.includes(team.teamKey) ? "text-amber-200 underline underline-offset-4" : "text-neutral-200"}`}>{formatTeamNumber(team.teamKey)}</span>
                          <span className="text-right"><span className="block text-[9px] text-neutral-600">OPR</span>{typeof team.opr === "number" ? team.opr.toFixed(1) : "—"}</span>
                          <span className="text-right"><span className="block text-[9px] text-neutral-600">DPR</span>{typeof team.dpr === "number" ? team.dpr.toFixed(1) : "—"}</span>
                          <span className="text-right"><span className="block text-[9px] text-neutral-600">CCWM</span>{typeof team.ccwm === "number" ? team.ccwm.toFixed(1) : "—"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="mt-3 text-sm text-neutral-500">OPR data has not been published for this event yet.</p>}
          </section>
          <p className="mt-4 text-[10px] leading-5 text-neutral-600">Official scores and breakdowns are shown only when published by TBA. Statbotics predictions are not yet connected; the integration will be isolated behind a replaceable service.</p>
        </div>
      )}
    </main>
  );
}

export default function MatchInsightsView({
  eventKey,
  trackedTeams = [],
}: {
  eventKey: string;
  trackedTeams?: string[];
}) {
  const snapshot = useEventState(eventKey);
  return <MatchInsightsContent eventKey={eventKey} snapshot={snapshot} trackedTeams={trackedTeams} />;
}
