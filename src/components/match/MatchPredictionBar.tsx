"use client";

type JsonRecord = Record<string, unknown>;

function exactNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

export default function MatchPredictionBar({
  prediction,
  status,
}: {
  prediction: JsonRecord;
  status: "loading" | "ready" | "unavailable";
}) {
  const redWinProbability = prediction.red_win_prob;
  if (typeof redWinProbability !== "number" || !Number.isFinite(redWinProbability)) {
    return (
      <section className="mb-4 rounded-xl p-4 sm:p-5">
        <div className="mb-4 grid grid-cols-2 gap-4">
          <div className="rounded-lg border border-red-400/15 bg-red-950/15 px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-red-300/60">Red predicted score</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums text-red-300">{exactNumber(prediction.red_score)}</div>
          </div>
          <div className="rounded-lg border border-blue-400/15 bg-blue-950/15 px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-blue-300/60">Blue predicted score</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums text-blue-300">{exactNumber(prediction.blue_score)}</div>
          </div>
        </div>
        <p className="text-xs text-neutral-500">{status === "loading" ? "Loading win probability…" : "Win probability unavailable."}</p>
      </section>
    );
  }

  const redPercent = redWinProbability * 100;
  const bluePercent = (1 - redWinProbability) * 100;
  const redWidth = Math.max(0, Math.min(1, redWinProbability)) * 100;

  return (
    <section className="mb-4 rounded-xl p-4 sm:p-5">
      <div className="mb-4 grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-red-400/15 bg-red-950/15 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-red-300/60">Red predicted score</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums text-red-300">{exactNumber(prediction.red_score)}</div>
        </div>
        <div className="rounded-lg border border-blue-400/15 bg-blue-950/15 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-blue-300/60">Blue predicted score</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums text-blue-300">{exactNumber(prediction.blue_score)}</div>
        </div>
      </div>
      <div>
        <div className="mb-2 flex justify-between text-xs">
          <span className="font-semibold text-red-300">Red {String(redPercent)}%</span>
          <span className="font-semibold text-blue-300">Blue {String(bluePercent)}%</span>
        </div>
        <div className="flex h-3 overflow-hidden rounded-full bg-blue-400/80" role="img" aria-label={`Red win probability ${String(redPercent)} percent; Blue win probability ${String(bluePercent)} percent`}>
          <div className="h-full bg-red-500 transition-[width]" style={{ width: String(redWidth) + "%" }} />
        </div>
      </div>
    </section>
  );
}
