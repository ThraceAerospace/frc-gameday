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
}: {
  color: "red" | "blue";
  prediction: JsonRecord;
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
    <div className={`h-full min-w-0 rounded-lg border px-4 py-3 ${colorStyles.border} ${colorStyles.background}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className={`text-[10px] font-bold uppercase tracking-[0.18em] ${colorStyles.label}`}>{color} alliance</div>
        <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest ${colorStyles.border} ${colorStyles.label}`}>Predicted</span>
      </div>
      <div className="flex h-full items-center gap-5">
        <div className="grid min-w-0 flex-1 grid-cols-4 gap-x-3 gap-y-2">
          <div className="min-w-0 shrink-0">
            <div className={`text-[10px] font-semibold uppercase tracking-widest ${colorStyles.label}`}>score</div>
            <div className={`mt-1 text-3xl font-semibold tabular-nums ${colorStyles.value}`}>{exactNumber(prediction[color + "_score"])}</div>
          </div>
          {predictedRpFields.map(({ key, label, value }) => (
            <div key={key} className="min-w-0">
              <div className={`text-[10px] font-semibold uppercase tracking-widest ${colorStyles.label}`}>{label}</div>
              <div className={`mt-1 text-3xl font-semibold tabular-nums ${colorStyles.value}`}>{exactNumber(value)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function MatchPredictionMetrics({ prediction }: { prediction: JsonRecord }) {
  return (
    <section className="mb-4 grid auto-rows-fr grid-cols-1 items-stretch gap-3 sm:grid-cols-2 sm:gap-4">
      <AlliancePredictionBox color="red" prediction={prediction} />
      <AlliancePredictionBox color="blue" prediction={prediction} />
    </section>
  );
}
