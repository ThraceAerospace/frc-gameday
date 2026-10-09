"use client";

import { useEffect, useState } from "react";
import type { TBAMatch } from "@/lib/tba/types";
import { formatTeamNumber, matchShortName } from "@/lib/tba/formatters";
import StatboticsMatchPredictionBar from "./StatboticsMatchPredictionBar";
import StatboticsMatchPredictionMetrics from "./StatboticsMatchPredictionMetrics";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function AllianceTeams({
  color,
  teams,
}: {
  color: "red" | "blue";
  teams: string[];
}) {
  const styles = color === "red"
    ? { label: "text-red-300", border: "border-red-400/20", background: "bg-red-950/30" }
    : { label: "text-blue-300", border: "border-blue-400/20", background: "bg-blue-950/30" };

  return (
    <div className="min-w-0">
      <div className={`mb-1 text-[9px] font-bold uppercase tracking-widest ${styles.label}`}>{color} alliance</div>
      <div className="flex flex-wrap gap-0.5">
        {teams.length > 0 ? teams.map((team) => (
          <span key={team} className={`rounded border px-1 py-0 font-mono text-[9px] font-semibold tabular-nums text-neutral-200 ${styles.border} ${styles.background}`}>
            {formatTeamNumber(team)}
          </span>
        )) : <span className="text-[10px] text-neutral-600">Teams unavailable</span>}
      </div>
    </div>
  );
}

export default function StatboticsPredictionStrip({
  match,
  playoffType = null,
}: {
  match: TBAMatch | null;
  playoffType?: number | null;
}) {
  const [payload, setPayload] = useState<JsonRecord | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    if (!match?.key) {
      setPayload(null);
      setStatus("unavailable");
      return;
    }

    const abort = new AbortController();
    setPayload(null);
    setStatus("loading");

    fetch("/api/statbotics/match/" + encodeURIComponent(match.key), {
      cache: "no-store",
      signal: abort.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Statbotics prediction unavailable");
      return await response.json() as JsonRecord;
    }).then((result) => {
      if (abort.signal.aborted) return;
      setPayload(result);
      setStatus("ready");
    }).catch(() => {
      if (!abort.signal.aborted) setStatus("unavailable");
    });

    return () => abort.abort();
  }, [match?.key]);

  if (!match) {
    return (
      <div className="flex min-h-[76px] items-center border-t border-white/10 bg-neutral-950/95 px-3 text-xs text-neutral-500">
        No match data available for a Statbotics prediction.
      </div>
    );
  }

  const prediction = asRecord(payload?.pred ?? payload?.prediction);

  return (
    <div className="border-t border-white/10 bg-neutral-950/95 px-2 py-1">
      <div className="grid min-w-0 grid-cols-[minmax(112px,0.45fr)_minmax(0,2fr)] items-center gap-2">
        <section className="flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1">
          <div className="min-w-0 shrink-0">
            <div className="text-[8px] font-semibold uppercase tracking-wider text-neutral-500">Match</div>
            <div className="truncate text-base font-bold leading-tight text-white" title={match.key}>
              {matchShortName(match, playoffType)}
            </div>
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-1 gap-1">
            <AllianceTeams color="red" teams={match.alliances.red.team_keys ?? []} />
            <AllianceTeams color="blue" teams={match.alliances.blue.team_keys ?? []} />
          </div>
        </section>
        <div className="grid min-w-0 grid-cols-[minmax(0,1.7fr)_minmax(100px,0.7fr)] items-center gap-1 rounded-lg border border-white/10 bg-neutral-950/95 px-1 py-0.5">
          <StatboticsMatchPredictionMetrics prediction={prediction} compact />
          <StatboticsMatchPredictionBar prediction={prediction} status={status} compact />
        </div>
      </div>
    </div>
  );
}
