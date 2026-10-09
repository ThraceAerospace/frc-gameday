"use client";

import { useEffect, useMemo, useState } from "react";
import type { EventStateSnapshot } from "@/lib/events/EventState";
import type { StatboticsMatch, StatboticsPrediction } from "@/lib/statbotics/types";
import type { TBAMatch } from "@/lib/tba/types";
import { formatTeamNumber, matchLongName } from "@/lib/tba/formatters";
import MatchPredictionBar from "./StatboticsMatchPredictionBar";
import MatchPredictionMetrics from "./StatboticsMatchPredictionMetrics";

type AllianceColor = "red" | "blue";
type AllianceEstimates = {
  opr: number | undefined;
  dpr: number | undefined;
  ccwm: number | undefined;
  epa: number | undefined;
  autoEpa: number | undefined;
  teleopEpa: number | undefined;
  endgameEpa: number | undefined;
};

const PRE_EPA_FIELDS = [
  ["epa", "EPA"],
  ["auto_epa", "Auto EPA"],
  ["teleop_epa", "Teleop EPA"],
  ["endgame_epa", "Endgame EPA"],
] as const;

function formatMetric(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
    : "—";
}

function teamNumberKey(teamKey: string): string {
  return teamKey.replace(/^frc/i, "");
}

function sumAvailableValues(values: (number | undefined)[]): number | undefined {
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return undefined;
  }
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function sumAllianceEstimates(
  teamKeys: string[],
  oprs: EventStateSnapshot["oprs"],
  preEpas: StatboticsMatch["pre_epas"],
): AllianceEstimates {
  const teamEpas = teamKeys.map((teamKey) => preEpas?.[teamNumberKey(teamKey)]);
  return {
    opr: sumAvailableValues(teamKeys.map((teamKey) => oprs?.oprs?.[teamKey])),
    dpr: sumAvailableValues(teamKeys.map((teamKey) => oprs?.dprs?.[teamKey])),
    ccwm: sumAvailableValues(teamKeys.map((teamKey) => oprs?.ccwms?.[teamKey])),
    epa: sumAvailableValues(teamEpas.map((epa) => epa?.epa)),
    autoEpa: sumAvailableValues(teamEpas.map((epa) => epa?.auto_epa)),
    teleopEpa: sumAvailableValues(teamEpas.map((epa) => epa?.teleop_epa)),
    endgameEpa: sumAvailableValues(teamEpas.map((epa) => epa?.endgame_epa)),
  };
}

function AllianceCard({
  color,
  match,
  snapshot,
  trackedTeams,
  preEpas,
}: {
  color: AllianceColor;
  match: TBAMatch;
  snapshot: EventStateSnapshot;
  trackedTeams: string[];
  preEpas: StatboticsMatch["pre_epas"];
}) {
  const alliance = match.alliances[color];
  const allianceTeams = alliance.team_keys ?? [];
  const teamNames = useMemo(
    () => new Map(snapshot.teams.map((team) => [team.key, team.nickname ?? team.name ?? team.key] as const)),
    [snapshot.teams],
  );
  const totals = sumAllianceEstimates(allianceTeams, snapshot.oprs, preEpas);
  const scorePosted = typeof alliance.score === "number" && alliance.score >= 0;
  const winner = match.winning_alliance === color;
  const tied = match.winning_alliance === "";
  const colorClasses = color === "red"
    ? { border: "border-red-400/30", header: "border-red-400/20", text: "text-red-300", tint: "bg-red-950/20", sticky: "bg-[#1a0b0d]" }
    : { border: "border-blue-400/30", header: "border-blue-400/20", text: "text-blue-300", tint: "bg-blue-950/20", sticky: "bg-[#091321]" };

  return (
    <section className={`min-w-0 overflow-hidden rounded-2xl border ${colorClasses.border} ${colorClasses.tint}`}>
      <header className={`border-b px-4 py-3 ${colorClasses.header}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={`text-xs font-bold uppercase tracking-[0.18em] ${colorClasses.text}`}>{color} alliance</span>
          <span className="text-xs text-neutral-500">Team estimates · alliance total</span>
          <span className="ml-auto text-2xl font-semibold tabular-nums text-white">{scorePosted ? alliance.score : "—"}</span>
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-neutral-500">
            <tr>
              <th className="sticky left-0 z-10 px-3 py-2">Team</th>
              <th className="px-2 py-2 text-right">OPR</th>
              <th className="px-2 py-2 text-right">DPR</th>
              <th className="px-2 py-2 text-right">CCWM</th>
              {PRE_EPA_FIELDS.map(([key, label]) => <th key={key} className="px-2 py-2 text-right">{label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {allianceTeams.map((teamKey) => {
              const tracked = trackedTeams.includes(teamKey);
              const teamEpa = preEpas?.[teamNumberKey(teamKey)];
              return (
                <tr key={teamKey} className={tracked ? "bg-amber-300/[0.08]" : ""}>
                  <th scope="row" className={`sticky left-0 z-10 min-w-32 ${colorClasses.sticky} px-3 py-3 text-left font-normal`}>
                    <div className={`font-mono text-xl font-bold tabular-nums ${tracked ? "text-amber-200 underline decoration-amber-400 decoration-2 underline-offset-4" : "text-white"}`}>{formatTeamNumber(teamKey)}</div>
                    <div className="mt-1 max-w-40 truncate text-md text-neutral-400">{teamNames.get(teamKey) ?? teamKey}</div>
                  </th>
                  <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-neutral-300">{formatMetric(snapshot.oprs?.oprs?.[teamKey])}</td>
                  <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-neutral-300">{formatMetric(snapshot.oprs?.dprs?.[teamKey])}</td>
                  <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-neutral-300">{formatMetric(snapshot.oprs?.ccwms?.[teamKey])}</td>
                  {PRE_EPA_FIELDS.map(([key]) => (
                    <td key={key} className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-neutral-300">{formatMetric(teamEpa?.[key])}</td>
                  ))}
                </tr>
              );
            })}
            <tr className="border-t border-white/15 bg-white/[0.04]">
              <th scope="row" className={`sticky left-0 z-10 min-w-32 ${colorClasses.sticky} px-3 py-3 text-left text-xs font-bold uppercase tracking-wider text-white`}>Alliance total</th>
              <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-white">{formatMetric(totals.opr)}</td>
              <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-white">{formatMetric(totals.dpr)}</td>
              <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-white">{formatMetric(totals.ccwm)}</td>
              <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-white">{formatMetric(totals.epa)}</td>
              <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-white">{formatMetric(totals.autoEpa)}</td>
              <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-white">{formatMetric(totals.teleopEpa)}</td>
              <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-white">{formatMetric(totals.endgameEpa)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {scorePosted && (winner || tied) ? (
        <footer className="border-t border-white/10 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
          {tied ? "Official result: tie" : winner ? "Official winner" : "Final score"}
        </footer>
      ) : null}
    </section>
  );
}

function ScoreBreakdown({
  match,
  year,
}: {
  match: TBAMatch;
  year: number | undefined;
}) {
  const breakdown = match.score_breakdown;
  if (!breakdown || !match.alliances || match.alliances.red.score < 0 || match.alliances.blue.score < 0) return null;

  if (year === 2026 && "hubScore" in breakdown.red && "hubScore" in breakdown.blue) {
    const red = breakdown.red;
    const blue = breakdown.blue;
    return (
      <section className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-300">Official score breakdown · 2026</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(["red", "blue"] as const).map((color) => {
            const side = color === "red" ? red : blue;
            const styles = color === "red" ? "border-red-400/20 bg-red-950/10" : "border-blue-400/20 bg-blue-950/10";
            return (
              <div key={color} className={`rounded-lg border p-3 ${styles}`}>
                <h3 className={`mb-2 text-xs font-bold uppercase ${color === "red" ? "text-red-300" : "text-blue-300"}`}>{color} alliance</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-neutral-400">Auto points</dt><dd className="text-right tabular-nums">{side.totalAutoPoints}</dd>
                  <dt className="text-neutral-400">Teleop points</dt><dd className="text-right tabular-nums">{side.totalTeleopPoints}</dd>
                  <dt className="text-neutral-400">Tower points</dt><dd className="text-right tabular-nums">{side.totalTowerPoints}</dd>
                  <dt className="text-neutral-400">Hub auto</dt><dd className="text-right tabular-nums">{side.hubScore.autoPoints} ({side.hubScore.autoCount} fuel)</dd>
                  <dt className="text-neutral-400">Hub transition</dt><dd className="text-right tabular-nums">{side.hubScore.transitionPoints} ({side.hubScore.transitionCount} fuel)</dd>
                  <dt className="text-neutral-400">Hub shift 1</dt><dd className="text-right tabular-nums">{side.hubScore.shift1Points} ({side.hubScore.shift1Count} fuel)</dd>
                  <dt className="text-neutral-400">Hub shift 2</dt><dd className="text-right tabular-nums">{side.hubScore.shift2Points} ({side.hubScore.shift2Count} fuel)</dd>
                  <dt className="text-neutral-400">Hub shift 3</dt><dd className="text-right tabular-nums">{side.hubScore.shift3Points} ({side.hubScore.shift3Count} fuel)</dd>
                  <dt className="text-neutral-400">Hub shift 4</dt><dd className="text-right tabular-nums">{side.hubScore.shift4Points} ({side.hubScore.shift4Count} fuel)</dd>
                  <dt className="text-neutral-400">Hub endgame</dt><dd className="text-right tabular-nums">{side.hubScore.endgamePoints} ({side.hubScore.endgameCount} fuel)</dd>
                  <dt className="text-neutral-400">Auto tower</dt><dd className="text-right tabular-nums">{side.autoTowerPoints}</dd>
                  <dt className="text-neutral-400">Endgame tower</dt><dd className="text-right tabular-nums">{side.endGameTowerPoints}</dd>
                  <dt className="text-neutral-400">Foul points</dt><dd className="text-right tabular-nums">{side.foulPoints}</dd>
                  <dt className="text-neutral-400">RP earned</dt><dd className="text-right tabular-nums">{side.rp}</dd>
                </dl>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  const formatLabel = (key: string) => key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

  const renderEntries = (value: object, prefix = "") =>
    Object.entries(value).map(([key, fieldValue]) => {
      const label = formatLabel(key);
      const nested = typeof fieldValue === "object" && fieldValue !== null && !Array.isArray(fieldValue);
      if (nested) {
        return (
          <div key={prefix + key} className="col-span-full rounded-md bg-black/15 p-2">
            <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{label}</h4>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {Object.entries(fieldValue).map(([childKey, childValue]) => (
                <div key={childKey} className="flex flex-col gap-0.5">
                  <dt className="text-xs text-neutral-500">{formatLabel(childKey)}</dt>
                  <dd className="text-sm tabular-nums text-neutral-200">{String(childValue)}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      }
      return (
        <div key={prefix + key} className="flex flex-col gap-0.5">
          <dt className="text-xs text-neutral-500">{label}</dt>
          <dd className="text-sm tabular-nums text-neutral-200">{fieldValue == null ? "—" : String(fieldValue)}</dd>
        </div>
      );
    });

  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-300">Official score breakdown · {year ?? "match year"}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(["red", "blue"] as const).map((color) => (
          <div key={color} className={`rounded-lg border p-3 ${color === "red" ? "border-red-400/20 bg-red-950/10" : "border-blue-400/20 bg-blue-950/10"}`}>
            <h3 className={`mb-2 text-xs font-bold uppercase ${color === "red" ? "text-red-300" : "text-blue-300"}`}>{color} alliance</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">{renderEntries(breakdown[color], color)}</dl>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function EventInsightView({
  eventKey,
  snapshot,
  trackedTeams = [],
  matchOverride = null,
}: {
  eventKey: string;
  snapshot: EventStateSnapshot;
  trackedTeams?: string[];
  matchOverride?: TBAMatch | null;
}) {
  const { event, eventNextMatch, eventLastMatch, loading, error } = snapshot;
  const [displayMatchKey, setDisplayMatchKey] = useState<string | null>(matchOverride?.key ?? eventNextMatch?.key ?? eventLastMatch?.key ?? null);
  const [resultMatchKey, setResultMatchKey] = useState<string | null>(null);
  const currentDisplayedMatch = matchOverride?.key === displayMatchKey
    ? matchOverride
    : snapshot.matches.find((item) => item.key === displayMatchKey) ?? null;
  const currentResultPosted = Boolean(
    currentDisplayedMatch &&
    typeof currentDisplayedMatch.alliances.red.score === "number" &&
    currentDisplayedMatch.alliances.red.score >= 0 &&
    typeof currentDisplayedMatch.alliances.blue.score === "number" &&
    currentDisplayedMatch.alliances.blue.score >= 0
  );

  useEffect(() => {
    if (matchOverride) {
      setDisplayMatchKey(matchOverride.key);
      setResultMatchKey(null);
      return;
    }
    const nextMatch = snapshot.eventNextMatch;
    if (!nextMatch) {
      if (snapshot.eventLastMatch) {
        setDisplayMatchKey(snapshot.eventLastMatch.key);
        if (currentResultPosted) setResultMatchKey(snapshot.eventLastMatch.key);
      }
      return;
    }
    if (!displayMatchKey) {
      setDisplayMatchKey(nextMatch.key);
      return;
    }
    if (displayMatchKey === nextMatch.key) return;
    if (currentResultPosted) {
      setResultMatchKey(displayMatchKey);
      const timeout = window.setTimeout(() => {
        setDisplayMatchKey(nextMatch.key);
        setResultMatchKey(null);
      }, 5000);
      return () => window.clearTimeout(timeout);
    }
    setDisplayMatchKey(nextMatch.key);
    setResultMatchKey(null);
  }, [matchOverride?.key, snapshot.eventNextMatch?.key, snapshot.eventLastMatch?.key, displayMatchKey, currentResultPosted]);

  const displayMatch =
    (matchOverride?.key === displayMatchKey ? matchOverride : null) ??
    snapshot.matches.find((item) => item.key === displayMatchKey) ??
    (eventNextMatch?.key === displayMatchKey ? eventNextMatch : null) ??
    (eventLastMatch?.key === displayMatchKey ? eventLastMatch : null);

  const statboticsState = displayMatch ? snapshot.statboticsMatches[displayMatch.key] : undefined;
  const statboticsData = statboticsState?.data ?? null;
  const statboticsStatus = statboticsState?.status ?? "loading";
  const prediction: StatboticsPrediction | undefined = statboticsData?.pred ?? statboticsData?.prediction;
  const preEpas = statboticsData?.pre_epas;

  const isPostMatch = Boolean(
    displayMatch &&
    typeof displayMatch.alliances.red.score === "number" &&
    displayMatch.alliances.red.score >= 0 &&
    typeof displayMatch.alliances.blue.score === "number" &&
    displayMatch.alliances.blue.score >= 0
  );
  const isShowingTransitionResult = Boolean(resultMatchKey && resultMatchKey === displayMatch?.key);
  const eventTitle = event?.short_name || event?.name || eventKey;

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[#07090d] text-white">
      <header className="shrink-0 border-b border-white/10 bg-neutral-950/80 px-5 py-4 sm:px-7">
        <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-neutral-500">FieldView · Match Insights</div>
        <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-baseline gap-2">
          <h1 className="min-w-0 truncate text-left text-lg font-semibold sm:text-xl">{eventTitle}</h1>
          <h1 className="min-w-0 truncate text-center text-xl font-semibold text-neutral-200">{displayMatch ? matchLongName(displayMatch, event?.playoff_type ?? null) : "No match selected"}</h1>
          <span className="text-right text-xs text-neutral-500">{displayMatch ? displayMatch.key : ""}</span>
        </div>
      </header>

      {error ? <div className="mx-5 mt-4 rounded-lg border border-red-400/20 bg-red-950/30 p-3 text-sm text-red-200">Event data is temporarily unavailable.</div> : null}

      {!displayMatch ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
          <div>
            <div className="text-base font-semibold text-neutral-200">{loading ? "Loading event and match data…" : "No upcoming match"}</div>
            <p className="mt-2 max-w-md text-sm leading-6 text-neutral-500">Match Insights follows the event schedule, unless a match is explicitly selected from the match strip.</p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
          {isPostMatch ? <div className="mb-4 rounded-lg border border-emerald-400/20 bg-emerald-950/20 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-emerald-200">{isShowingTransitionResult ? "Official result · next match loading" : "Official result available"}</div> : null}
          <MatchPredictionBar prediction={prediction} status={statboticsStatus} />
          <MatchPredictionMetrics prediction={prediction} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <AllianceCard color="red" match={displayMatch} snapshot={snapshot} trackedTeams={trackedTeams} preEpas={preEpas} />
            <AllianceCard color="blue" match={displayMatch} snapshot={snapshot} trackedTeams={trackedTeams} preEpas={preEpas} />
          </div>
          {isPostMatch ? <ScoreBreakdown match={displayMatch} year={statboticsData?.year ?? Number(displayMatch.key.slice(0, 4))} /> : null}
          <p className="mt-4 text-[10px] leading-5 text-neutral-600">Predicted values and pre-match EPAs are provided by Statbotics. Official scores and year-specific score breakdowns are from TBA. Statbotics numeric values are formatted for readability, and alliance estimates are the sum of the individual team estimates.</p>
        </div>
      )}
    </main>
  );
}
