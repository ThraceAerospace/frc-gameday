"use client";

type JsonRecord = Record<string, unknown>;

function exactNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function probabilityPercent(value: number, complement = false): string {
  const source = String(value);
  if (/[eE]/.test(source)) {
    return String((complement ? 1 - value : value) * 100);
  }

  const [whole = "0", fraction = ""] = source.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * scale + BigInt(fraction || "0");
  const adjusted = complement ? scale - numerator : numerator;
  const percentNumerator = adjusted * 100n;
  const integerPart = percentNumerator / scale;
  const remainder = percentNumerator % scale;
  if (remainder === 0n) return String(integerPart);

  const decimalPart = remainder.toString().padStart(fraction.length, "0").replace(/0+$/, "");
  return String(integerPart) + "." + decimalPart;
}

function formatPredictionLabel(key: string): string {
  return key
    .replace(/_rp$/, " RP")
    .replace(/_/g, " ")
    .replace(/\\b[a-z]/g, (character) => character.toUpperCase());
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
    <div className={`rounded-lg border px-4 py-3 ${colorStyles.border} ${colorStyles.background}`}>
      <div className={`text-[10px] font-semibold uppercase tracking-widest ${colorStyles.label}`}>{color} predicted score</div>
      <div className={`mt-1 text-3xl font-semibold tabular-nums ${colorStyles.value}`}>{exactNumber(prediction[color + "_score"])}</div>
      <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2">
        {predictedRpFields.map(({ key, label, value }) => (
          <div key={key} className="min-w-0">
            <div className="truncate text-[9px] uppercase tracking-wider text-neutral-500">{label}</div>
            <div className={`mt-0.5 font-mono text-xs font-semibold tabular-nums ${colorStyles.value}`}>{exactNumber(value)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MatchPredictionBar({
  prediction,
  status,
}: {
  prediction: JsonRecord;
  status: "loading" | "ready" | "unavailable";
}) {
  const redWinProbability = prediction.red_win_prob;
  const hasProbability = typeof redWinProbability === "number" && Number.isFinite(redWinProbability);
  const redPercent = hasProbability ? probabilityPercent(redWinProbability) : null;
  const bluePercent = hasProbability ? probabilityPercent(redWinProbability, true) : null;
  const redWidth = hasProbability ? Math.max(0, Math.min(1, redWinProbability)) * 100 : 50;

  return (
    <section className="mb-4 rounded-xl p-4 sm:p-5">
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        <AlliancePredictionBox color="red" prediction={prediction} />
        <AlliancePredictionBox color="blue" prediction={prediction} />
      </div>
      {hasProbability ? (
        <div>
          <div className="mb-2 flex justify-between text-xs">
            <span className="font-semibold text-red-300">Red {redPercent}%</span>
            <span className="font-semibold text-blue-300">Blue {bluePercent}%</span>
          </div>
          <div className="flex h-3 overflow-hidden rounded-full bg-blue-400/80" role="img" aria-label={`Red win probability ${String(redPercent)} percent; Blue win probability ${String(bluePercent)} percent`}>
            <div className="h-full bg-red-500 transition-[width]" style={{ width: String(redWidth) + "%" }} />
          </div>
        </div>
      ) : (
        <p className="text-xs text-neutral-500">{status === "loading" ? "Loading win probability…" : "Win probability unavailable."}</p>
      )}
    </section>
  );
}
