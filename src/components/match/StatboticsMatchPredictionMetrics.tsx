"use client";

type JsonRecord = Record<string, unknown>;

function exactNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function formatPredictionLabel(key: string): string {
  return key
    .replace(/_rp$/, " RP")
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

function AlliancePredictionBox({
  color,
  prediction,
  compact,
}: {
  color: "red" | "blue";
  prediction: JsonRecord;
  compact: boolean;
}) {
  const predictedRpFields = Object.entries(prediction)
    .filter(([key, value]) =>
      key.startsWith(color + "_") &&
      key.endsWith("_rp") &&
      !new RegExp("^" + color + "_rp_\\d+$").test(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
    .map(([key, value]) => ({
      key,
      label: formatPredictionLabel(key.slice(color.length + 1)),
      value,
    }));
  const colorStyles = color === "red"
    ? { border: "border-red-400/15", background: "bg-red-950/15", label: "text-red-300/60", value: "text-red-300" }
    : { border: "border-blue-400/15", background: "bg-blue-950/15", label: "text-blue-300/60", value: "text-blue-300" };

  return (
    <div className={`h-full min-w-0 rounded-lg border ${compact ? "px-2 py-0.5" : "px-4 py-3"} ${colorStyles.border} ${colorStyles.background}`}>
      <div className="flex h-full items-center">
        <div className={`grid min-w-0 flex-1 grid-cols-4 ${compact ? "gap-x-2" : "gap-x-3 gap-y-2"}`}>
          <div className="min-w-0 shrink-0">
            <div className={`${compact ? "text-[8px] tracking-wide" : "text-[10px] tracking-widest"} font-semibold uppercase ${colorStyles.label}`}>score</div>
            <div className={`${compact ? "mt-0 text-sm" : "mt-1 text-3xl"} font-semibold tabular-nums ${colorStyles.value}`}>{exactNumber(prediction[color + "_score"])}</div>
          </div>
          {predictedRpFields.map(({ key, label, value }) => (
            <div key={key} className="min-w-0">
              <div className={`${compact ? "text-[8px] tracking-wide" : "text-[10px] tracking-widest"} font-semibold uppercase ${colorStyles.label}`}>{label}</div>
              <div className={`${compact ? "mt-0 text-sm" : "mt-1 text-3xl"} font-semibold tabular-nums ${colorStyles.value}`}>{exactNumber(value)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function MatchPredictionMetrics({ prediction, compact = false }: { prediction: JsonRecord; compact?: boolean }) {
  return (
    <section className={`${compact ? "m-0 shrink-0 rounded-none p-0" : "mb-4 rounded-xl border border-white/10 bg-white/[0.02] p-3 sm:p-4"}`}>
      {!compact && (
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
          Statbotics Prediction
        </div>
      )}
      <div className={`grid auto-rows-fr grid-cols-1 items-stretch ${compact ? "mt-0 gap-1 sm:grid-cols-2 sm:gap-2" : "gap-3 sm:grid-cols-2 sm:gap-4"}`}>
        <AlliancePredictionBox color="red" prediction={prediction} compact={compact} />
        <AlliancePredictionBox color="blue" prediction={prediction} compact={compact} />
      </div>
    </section>
  );
}
