"use client";

import { useEffect, useMemo, useState } from "react";
import { useEventState } from "@/lib/events";
import type { EventStateSnapshot } from "@/lib/events/EventState";
import type { TBAMatch } from "@/lib/tba/types";
import { formatTeamNumber, matchLongName } from "@/lib/tba/formatters";
import MatchPredictionBar from "./MatchPredictionBar";

type AllianceColor = "red" | "blue";
type JsonRecord = Record<string, unknown>;
type TeamEstimates = {
  opr?: number;
  dpr?: number;
  ccwm?: number;
  preEpa?: JsonRecord;
};

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function exactNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function teamNumberKey(teamKey: string): string {
  return teamKey.replace(/^frc/i, "");
}

const PRE_EPA_FIELDS = [
  ["epa", "EPA"],
  ["auto_epa", "Auto EPA"],
  ["teleop_epa", "Teleop EPA"],
  ["endgame_epa", "Endgame EPA"],
] as const;

const ALLIANCE_METRICS = [
  { key: "opr", label: "OPR" },
  { key: "dpr", label: "DPR" },
  { key: "ccwm", label: "CCWM" },
  { key: "epa", label: "EPA" },
  { key: "auto_epa", label: "Auto" },
  { key: "teleop_epa", label: "Teleop" },
  { key: "endgame_epa", label: "Endgame" },
] as const;

function AllianceCard({
  color,
  match,
  snapshot,
  trackedTeams,
  estimates,
}: {
  color: AllianceColor;
  match: TBAMatch;
  snapshot: EventStateSnapshot;
  trackedTeams: string[];
  estimates: Record<string, TeamEstimates>;
}) {
  const alliance = match.alliances[color];
  const allianceTeams = alliance.team_keys ?? [];
  const teamNames = useMemo(
    () => new Map(snapshot.teams.map((team) => [team.key, team.nickname ?? team.name ?? team.key] as const)),
    [snapshot.teams],
  );
  const scorePosted = typeof alliance.score === "number" && alliance.score >= 0;
  const winner = match.winning_alliance === color;
  const tied = match.winning_alliance === "";
  const colorClasses = color === "red"
    ? { border: "border-red-400/30", header: "border-red-400/20", text: "text-red-300", tint: "bg-red-950/20", sticky: "bg-[#1a0b0d]" }
    : { border: "border-blue-400/30", header: "border-blue-400/20", text: "text-blue-300", tint: "bg-blue-950/20", sticky: "bg-[#091321]" };

  const totals = useMemo(() => {
    const values: Record<string, number | undefined> = {};
    for (const metric of ALLIANCE_METRICS) {
      const teamValues = allianceTeams.map((teamKey) => {
        const team = estimates[teamKey];
        if (metric.key === "opr" || metric.key === "dpr" || metric.key === "ccwm") {
          return team?.[metric.key];
        }
        return team?.preEpa?.[metric.key] as number | undefined;
      });
      values[metric.key] = teamValues.length > 0 && teamValues.every((value) => typeof value === "number" && Number.isFinite(value))
        ? teamValues.reduce((sum, value) => sum + (value as number), 0)
        : undefined;
    }
    return values;
  }, [allianceTeams, estimates]);

  return (
    <section className={`min-w-0 overflow-hidden rounded-2xl border ${colorClasses.border} ${colorClasses.tint}`}>
      <header className={`border-b px-4 py-3 ${colorClasses.header}`}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span className={`text-xs font-bold uppercase tracking-[0.18em] ${colorClasses.text}`}>{color} alliance</span>
          <span className="text-2xl font-semibold tabular-nums text-white">{scorePosted ? alliance.score : "—"}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-neutral-500">Combined</span>
          {ALLIANCE_METRICS.map((metric) => (
            <span key={metric.key} className="whitespace-nowrap text-[10px] text-neutral-400">
              {metric.label} <strong className="font-mono font-semibold tabular-nums text-neutral-200">{exactNumber(totals[metric.key])}</strong>
            </span>
          ))}
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-left text-xs">
          <thead className="bg-black/20 text-[10px] uppercase tracking-wider text-neutral-500">
            <tr>
              <th className="sticky left-0 z-10 bg-neutral-950/95 px-3 py-2">Team</th>
              <th className="px-2 py-2 text-right">OPR</th>
              <th className="px-2 py-2 text-right">DPR</th>
              <th className="px-2 py-2 text-right">CCWM</th>
              {PRE_EPA_FIELDS.map(([key, label]) => <th key={key} className="px-2 py-2 text-right">{label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {allianceTeams.map((teamKey) => {
              const tracked = trackedTeams.includes(teamKey);
              const teamEstimates = estimates[teamKey];
              return (
                <tr key={teamKey} className={tracked ? "bg-amber-300/[0.08]" : ""}>
                  <th scope="row" className={`sticky left-0 z-10 min-w-32 ${colorClasses.sticky} px-3 py-3 text-left font-normal`}>
                    <div className={`font-mono text-xl font-bold tabular-nums ${tracked ? "text-amber-200 underline decoration-amber-400 decoration-2 underline-offset-4" : "text-white"}`}>{formatTeamNumber(teamKey)}</div>
                    <div className="mt-1 max-w-40 truncate text-[10px] text-neutral-400">{teamNames.get(teamKey) ?? teamKey}</div>
                  </th>
                  <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-neutral-300">{exactNumber(teamEstimates?.opr)}</td>
                  <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-neutral-300">{exactNumber(teamEstimates?.dpr)}</td>
                  <td className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-neutral-300">{exactNumber(teamEstimates?.ccwm)}</td>
                  {PRE_EPA_FIELDS.map(([key]) => (
                    <td key={key} className="px-2 py-3 text-right font-mono text-lg font-bold tabular-nums text-neutral-300">{exactNumber(teamEstimates?.preEpa?.[key])}</td>
                  ))}
                </tr>
              );
            })}
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

export function MatchInsightsContent({
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
  const { event, eventNextMatch, eventLastMatch, loading, error, oprs } = snapshot;
  const [displayMatchKey, setDisplayMatchKey] = useState<string | null>(matchOverride?.key ?? eventNextMatch?.key ?? eventLastMatch?.key ?? null);
  const [resultMatchKey, setResultMatchKey] = useState<string | null>(null);
  const [statboticsData, setStatboticsData] = useState<JsonRecord | null>(null);
  const [statboticsStatus, setStatboticsStatus] = useState<"loading" | "ready" | "unavailable">("loading");
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

  useEffect(() => {
    if (!displayMatch?.key) {
      setStatboticsData(null);
      setStatboticsStatus("unavailable");
      return;
    }

    const abort = new AbortController();
    setStatboticsData(null);
    setStatboticsStatus("loading");

    fetch("/api/statbotics/match/" + encodeURIComponent(displayMatch.key), {
      cache: "no-store",
      signal: abort.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Statbotics prediction unavailable");
      return await response.json() as JsonRecord;
    }).then((payload) => {
      if (abort.signal.aborted) return;
      setStatboticsData(payload);
      setStatboticsStatus("ready");
    }).catch(() => {
      if (!abort.signal.aborted) setStatboticsStatus("unavailable");
    });

    return () => abort.abort();
  }, [displayMatch?.key]);

  const isPostMatch = Boolean(
    displayMatch &&
    typeof displayMatch.alliances.red.score === "number" &&
    displayMatch.alliances.red.score >= 0 &&
    typeof displayMatch.alliances.blue.score === "number" &&
    displayMatch.alliances.blue.score >= 0
  );
  const isShowingTransitionResult = Boolean(resultMatchKey && resultMatchKey === displayMatch?.key);
  const eventTitle = event?.short_name || event?.name || eventKey;
  const prediction = asRecord(statboticsData?.pred ?? statboticsData?.prediction);
  const redWinProbability = prediction.red_win_prob;
  const preEpas = asRecord(statboticsData?.pre_epas);
  const estimates = useMemo(() => {
    const result: Record<string, TeamEstimates> = {};
    if (displayMatch) {
      for (const color of ["red", "blue"] as const) {
        for (const teamKey of displayMatch.alliances[color].team_keys ?? []) {
          const numericKey = teamNumberKey(teamKey);
          result[teamKey] = {
            opr: oprs?.oprs?.[teamKey],
            dpr: oprs?.dprs?.[teamKey],
            ccwm: oprs?.ccwms?.[teamKey],
            preEpa: asRecord(preEpas[numericKey]),
          };
        }
      }
    }
    return result;
  }, [displayMatch, oprs, preEpas]);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-[#07090d] text-white">
      <header className="shrink-0 border-b border-white/10 bg-neutral-950/80 px-5 py-4 sm:px-7">
        <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-neutral-500">FieldView · Match Insights</div>
        <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-baseline gap-2">
          <h1 className="min-w-0 truncate text-left text-lg font-semibold sm:text-xl">{eventTitle}</h1>
          <h1 className="min-w-0 truncate text-center text-sm font-semibold text-neutral-200">{displayMatch ? matchLongName(displayMatch) : "No match selected"}</h1>
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
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <AllianceCard color="red" match={displayMatch} snapshot={snapshot} trackedTeams={trackedTeams} estimates={estimates} />
            <AllianceCard color="blue" match={displayMatch} snapshot={snapshot} trackedTeams={trackedTeams} estimates={estimates} prediction={prediction} />
          </div>
          <p className="mt-4 text-[10px] leading-5 text-neutral-600">Predicted values and pre-match EPAs are provided by Statbotics. Official scores and breakdowns are shown only when published by TBA. Numeric Statbotics values are displayed without application-side rounding or truncation.</p>
        </div>
      )}
    </main>
  );
}

export default function MatchInsightsView({
  eventKey,
  trackedTeams = [],
  onClose,
  matchOverride = null,
}: {
  eventKey: string;
  trackedTeams?: string[];
  onClose?: () => void;
  matchOverride?: TBAMatch | null;
}) {
  const snapshot = useEventState(eventKey);

  useEffect(() => {
    if (!onClose) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return <MatchInsightsContent eventKey={eventKey} snapshot={snapshot} trackedTeams={trackedTeams} matchOverride={matchOverride} />;
}
