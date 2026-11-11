import Link from "next/link";
import type { StatboticsMatch } from "@/lib/statbotics/types";
import type { TBAEventOPRs, TBAMatch } from "@/lib/tba/types";

type Props = {
  match: TBAMatch;
  statbotics: StatboticsMatch | null;
  oprs: TBAEventOPRs | null;
};

const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function metric(value: unknown): string {
  return number(value) ? value.toFixed(1) : "—";
}

function signed(value: number | null): string {
  return value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function score(value: unknown): number | null {
  return number(value) && value >= 0 ? value : null;
}

function teamId(teamKey: string): string {
  return teamKey.replace(/^frc/i, "");
}

function ScoreComparison({
  label,
  predicted,
  actual,
  color,
}: {
  label: string;
  predicted: number | null | undefined;
  actual: number | null;
  color: "red" | "blue";
}) {
  const residual = actual !== null && number(predicted) ? actual - predicted : null;
  const tint = color === "red" ? "text-red-300" : "text-blue-300";
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
      <div className={`text-xs font-bold uppercase tracking-wider ${tint}`}>{label} alliance</div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div><div className="text-[10px] uppercase tracking-wide text-neutral-500">Predicted</div><div className="mt-1 text-2xl font-semibold tabular-nums text-white">{metric(predicted)}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-neutral-500">Actual</div><div className="mt-1 text-2xl font-semibold tabular-nums text-white">{actual === null ? "—" : metric(actual)}</div></div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-2 text-xs">
        <span className="text-neutral-500">Actual − predicted</span>
        <strong className={residual === null ? "text-neutral-400" : residual >= 0 ? "text-emerald-300" : "text-rose-300"}>{signed(residual)} pts</strong>
      </div>
    </div>
  );
}

export default function MatchInsightsPanel({ match, statbotics, oprs }: Props) {
  const prediction = statbotics?.pred ?? undefined;
  const redActual = score(match.alliances.red.score);
  const blueActual = score(match.alliances.blue.score);
  const redPredicted = prediction?.red_score;
  const bluePredicted = prediction?.blue_score;
  const hasPrediction = number(redPredicted) || number(bluePredicted);
  const hasEpas = Boolean(statbotics?.pre_epas || statbotics?.epas);
  const teams = [
    ...match.alliances.red.team_keys.map((key) => ({ key, color: "red" as const })),
    ...match.alliances.blue.team_keys.map((key) => ({ key, color: "blue" as const })),
  ];

  return (
    <section className="mt-8 rounded-2xl border border-slate-200 bg-slate-950 p-5 text-white sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-blue-300">FieldView Insights</p>
          <h2 className="mt-1 text-xl font-semibold">Match analytics</h2>
          <p className="mt-1 text-sm text-neutral-400">Pre-match model estimates compared with the official result and the model's rating update.</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statbotics ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-200"}`}>{statbotics ? "Statbotics data available" : "Statbotics data unavailable"}</span>
      </div>

      {hasPrediction ? (
        <>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <ScoreComparison label="Red" predicted={redPredicted} actual={redActual} color="red"/>
            <ScoreComparison label="Blue" predicted={bluePredicted} actual={blueActual} color="blue"/>
          </div>
          {number(prediction?.red_win_prob) ? (
            <div className="mt-4 rounded-lg border border-white/10 p-4">
              <div className="flex justify-between text-xs font-semibold"><span className="text-red-300">Red {(prediction.red_win_prob * 100).toFixed(1)}%</span><span className="text-blue-300">Blue {((1 - prediction.red_win_prob) * 100).toFixed(1)}%</span></div>
              <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-blue-500"><div className="bg-red-500" style={{width:`${Math.max(0,Math.min(1,prediction.red_win_prob))*100}%`}}/></div>
              <p className="mt-2 text-[11px] text-neutral-500">Statbotics pre-match win probability. This is a model estimate, not a guarantee.</p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-4 rounded-lg border border-white/10 p-4 text-sm text-neutral-400">No Statbotics prediction is available for this match. FieldView does not substitute sample or placeholder values.</p>
      )}

      {hasEpas ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Team EPA before and after the match</h3>
          <p className="mt-1 text-xs leading-5 text-neutral-400">These are Statbotics model ratings, not points scored by each robot. The change reflects an alliance-level model update and must not be interpreted as an individual robot contribution.</p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="bg-white/[0.04] text-[10px] uppercase tracking-wider text-neutral-500"><tr><th className="px-3 py-3 text-left">Team</th><th className="px-3 py-3 text-right">Pre-match EPA</th><th className="px-3 py-3 text-right">Post-match EPA</th><th className="px-3 py-3 text-right">Model change</th><th className="px-3 py-3 text-right">OPR</th><th className="px-3 py-3 text-right">DPR</th><th className="px-3 py-3 text-right">CCWM</th></tr></thead>
              <tbody className="divide-y divide-white/[0.06]">
                {teams.map(({key,color}) => {
                  const id=teamId(key);
                  const before=statbotics?.pre_epas?.[id]?.epa;
                  const after=statbotics?.epas?.[id]?.epa;
                  const delta=number(before)&&number(after)?after-before:null;
                  return <tr key={key}>
                    <th className={`px-3 py-3 text-left font-mono ${color==="red"?"text-red-200":"text-blue-200"}`}><Link href={`/team/${id}`} className="hover:underline">{id}</Link></th>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{metric(before)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{metric(after)}</td>
                    <td className={`px-3 py-3 text-right font-mono tabular-nums ${delta===null?"text-neutral-500":delta>=0?"text-emerald-300":"text-rose-300"}`}>{signed(delta)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{metric(oprs?.oprs?.[key])}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{metric(oprs?.dprs?.[key])}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{metric(oprs?.ccwms?.[key])}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <p className="mt-4 text-[10px] leading-5 text-neutral-500">Sources: Statbotics match prediction and EPA snapshots; The Blue Alliance official match scores and event OPR/DPR/CCWM. Missing upstream values are shown as unavailable rather than inferred.</p>
    </section>
  );
}
