"use client";

import { useEffect, useState } from "react";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function firstNumber(...values: unknown[]): number | null {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value)) ?? null;
}

export default function StatboticsPrediction({ matchKey }: { matchKey: string }) {
  const [data, setData] = useState<JsonRecord | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    const abort = new AbortController();
    setData(null);
    setStatus("loading");

    fetch("/api/statbotics/match/" + encodeURIComponent(matchKey), {
      cache: "no-store",
      signal: abort.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Prediction unavailable");
      return await response.json() as JsonRecord;
    }).then((payload) => {
      if (abort.signal.aborted) return;
      setData(payload);
      setStatus("ready");
    }).catch(() => {
      if (!abort.signal.aborted) setStatus("unavailable");
    });

    return () => abort.abort();
  }, [matchKey]);

  const prediction = asRecord(data?.pred ?? data?.prediction);
  const redScore = firstNumber(prediction.red_score, prediction.red_score_predicted, prediction.redScore);
  const blueScore = firstNumber(prediction.blue_score, prediction.blue_score_predicted, prediction.blueScore);
  const rawWinProbability = firstNumber(prediction.red_win_prob, prediction.red_win_probability, prediction.redWinProb);
  const redWinProbability = rawWinProbability === null ? null : rawWinProbability <= 1 ? rawWinProbability * 100 : rawWinProbability;
  const winner = typeof prediction.winner === "string" ? prediction.winner.toLowerCase() : null;

  return (
    <section className="mt-4 rounded-2xl border border-violet-300/15 bg-violet-950/10 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Statbotics match prediction</h2>
        <span className="text-[10px] uppercase tracking-widest text-violet-200/60">Experimental API</span>
      </div>
      {status === "loading" ? (
        <p className="mt-3 text-sm text-neutral-500">Loading prediction…</p>
      ) : status === "unavailable" ? (
        <p className="mt-3 text-sm text-neutral-500">A Statbotics prediction is not available for this match yet.</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-red-400/20 bg-red-950/20 p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-red-300">Red predicted score</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums">{redScore === null ? "—" : redScore.toFixed(1)}</div>
            </div>
            <div className="rounded-xl border border-blue-400/20 bg-blue-950/20 p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-blue-300">Blue predicted score</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums">{blueScore === null ? "—" : blueScore.toFixed(1)}</div>
            </div>
          </div>
          {redWinProbability !== null ? (
            <div className="mt-4">
              <div className="mb-2 flex justify-between text-xs">
                <span className="font-semibold text-red-300">Red {redWinProbability.toFixed(1)}%</span>
                <span className="font-semibold text-blue-300">Blue {(100 - redWinProbability).toFixed(1)}%</span>
              </div>
              <div className="flex h-2 overflow-hidden rounded-full bg-blue-400/70">
                <div className="h-full bg-red-400" style={{ width: String(Math.max(0, Math.min(100, redWinProbability))) + "%" }} />
              </div>
            </div>
          ) : null}
          {winner === "red" || winner === "blue" ? (
            <p className="mt-3 text-xs text-neutral-400">Model favors the <span className={winner === "red" ? "font-semibold text-red-300" : "font-semibold text-blue-300"}>{winner} alliance</span>.</p>
          ) : null}
        </>
      )}
      <p className="mt-3 text-[10px] leading-5 text-neutral-600">Provided through the temporary Statbotics-compatible API adapter. Set STATBOTICS_API_BASE_URL to switch providers without changing this view.</p>
    </section>
  );
}
