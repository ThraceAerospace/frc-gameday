"use client";

type JsonRecord = Record<string, unknown>;

function probabilityPercent(value: number, complement = false): string {
  const source = String(value);
  if (/[eE]/.test(source)) {
    return String((complement ? 1 - value : value) * 100);
  }

  const [whole = "0", fraction = ""] = source.split(".");
  const scale = 10 ** fraction.length;
  const numerator = Number(whole) * scale + Number(fraction || "0");
  const adjusted = complement ? scale - numerator : numerator;
  const percentNumerator = adjusted * 100;
  const integerPart = Math.floor(percentNumerator / scale);
  const remainder = Math.round(percentNumerator % scale);
  if (remainder === 0) return String(integerPart);

  const decimalPart = String(remainder).padStart(fraction.length, "0").replace(/0+$/, "");
  return String(integerPart) + "." + decimalPart;
}

export default function MatchPredictionBar({
  prediction,
  status,
  compact = false,
}: {
  prediction: JsonRecord;
  status: "loading" | "ready" | "unavailable";
  compact?: boolean;
}) {
  const redWinProbability = prediction.red_win_prob;
  const hasProbability = typeof redWinProbability === "number" && Number.isFinite(redWinProbability);
  const redPercent = hasProbability ? probabilityPercent(redWinProbability) : null;
  const bluePercent = hasProbability ? probabilityPercent(redWinProbability, true) : null;
  const redWidth = hasProbability ? Math.max(0, Math.min(1, redWinProbability)) * 100 : 50;

  return (
    <section
      className={
        compact
          ? "w-full shrink-0 rounded-none px-0 py-0"
          : "mb-4 rounded-xl p-4 sm:p-5"
      }
    >
      {hasProbability ? (
        <div>
          {!compact && (
            <div className="mb-1 flex justify-between text-xs">
              <span className="font-semibold text-red-300">
                Red {redPercent}%
              </span>
              <span className="font-semibold text-blue-300">
                Blue {bluePercent}%
              </span>
            </div>
          )}

          <div
            className={`flex w-full overflow-hidden rounded-full bg-blue-400/80 ${
              compact ? "h-1" : "h-3"
            }`}
            role="img"
            aria-label={`Red win probability ${String(redPercent)} percent; Blue ${String(bluePercent)} percent`}
          >
            <div
              className="h-full bg-red-500 transition-[width]"
              style={{ width: `${redWidth}%` }}
            />
          </div>
        </div>
      ) : (
        <p className={compact ? "px-1 text-[10px] leading-none text-neutral-500" : "text-xs text-neutral-500"}>
          {status === "loading"
            ? "Loading win probability…"
            : "Win probability unavailable."}
        </p>
      )}
    </section>
  );
}
