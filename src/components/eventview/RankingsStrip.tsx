"use client";

import type {
  TBAEliminationAlliance,
  TBAEventRanking,
} from "@/lib/tba/types";

type RankingsStripProps = {
  rankings: TBAEventRanking | null;
  playoffAlliances?: TBAEliminationAlliance[];
  playoffType?: number | null;
};

function recordLabel(record: { wins?: number; losses?: number; ties?: number } | null | undefined) {
  if (!record) return "—";
  return `${record.wins ?? 0}-${record.losses ?? 0}-${record.ties ?? 0}`;
}

function playoffLevel(
  alliance: TBAEliminationAlliance,
  playoffType?: number | null,
) {
  const status = alliance.status;

  if (!status) return "—";

  if (playoffType === 10) {
    return status.double_elim_round ?? "—";
  }

  return status.level ?? "—";
}

function allianceLabel(alliance: TBAEliminationAlliance, index: number) {
  return alliance.name || `Alliance ${index + 1}`;
}

export default function RankingsStrip({
  rankings,
  playoffAlliances = [],
  playoffType = null,
}: RankingsStripProps) {
  const hasAlliances = playoffAlliances.length > 0;

  if (hasAlliances) {
    const currentAlliance =
      playoffAlliances.find((alliance) => alliance.status?.status === "playing") ??
      playoffAlliances.find((alliance) => alliance.status) ??
      playoffAlliances[0];

    return (
      <div className="relative min-w-0 overflow-hidden border-t border-white/10 bg-neutral-950/95">
        <div className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar">
          <div className="flex h-full min-w-max items-center gap-1.5 px-2">
            {playoffAlliances.map((alliance, index) => {
              const status = alliance.status;

              return (
                <article
                  key={alliance.name ?? index}
                  className={[
                    "flex h-[42px] shrink-0 items-center gap-3 rounded-md border px-3",
                    status?.status === "playing"
                      ? "border-white/20 bg-white/[0.08]"
                      : "border-zinc-800 bg-zinc-950",
                  ].join(" ")}
                >
                  <div className="flex flex-col justify-center">
                    <span className="text-[9px] font-bold uppercase tracking-wide text-neutral-400">
                      {allianceLabel(alliance, index)}
                    </span>
                    <span className="mt-0.5 text-[10px] font-semibold text-white">
                      {alliance.picks.map((team) => team.replace(/^frc/i, "")).join(" · ")}
                    </span>
                  </div>

                  <div className="h-6 w-px bg-white/10" />

                  <div className="flex flex-col justify-center text-right">
                    <span className="text-[9px] uppercase tracking-wide text-neutral-500">
                      {playoffType === 10 ? "DE Round" : "Level"}
                    </span>
                    <span className="font-mono text-[10px] text-neutral-300">
                      {playoffLevel(alliance, playoffType)}
                    </span>
                  </div>

                  <div className="flex flex-col justify-center text-right">
                    <span className="text-[9px] uppercase tracking-wide text-neutral-500">
                      Record
                    </span>
                    <span className="font-mono text-[10px] text-neutral-300">
                      {recordLabel(status?.record)}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        {currentAlliance ? (
          <div className="absolute bottom-full left-0 -mb-px rounded-t-lg border-x border-t border-white/10 bg-neutral-950 px-2 py-1 shadow-lg">
            <span className="text-[10px] font-bold text-white">
              Playoffs
            </span>
          </div>
        ) : null}
      </div>
    );
  }

  const entries = rankings?.rankings ?? [];

  return (
    <div className="relative min-w-0 overflow-hidden border-t border-white/10 bg-neutral-950/95">
      <div className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar">
        {entries.length > 0 ? (
          <div className="flex h-full min-w-max items-center gap-1.5 px-2">
            {entries.map((entry) => (
              <article
                key={entry.team_key}
                className="flex h-[42px] shrink-0 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3"
              >
                <span className="w-5 text-center font-mono text-[10px] font-bold text-white">
                  {entry.rank}
                </span>

                <span className="font-mono text-[11px] font-bold text-white">
                  {entry.team_key.replace(/^frc/i, "")}
                </span>

                <span className="h-5 w-px bg-white/10" />

                <span className="font-mono text-[10px] text-neutral-400">
                  RP {entry.sort_orders[0] ?? "—"}
                </span>

                <span className="font-mono text-[10px] text-neutral-500">
                  {recordLabel(entry.record)}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center px-3 text-[10px] text-neutral-600">
            Rankings are not available yet
          </div>
        )}
      </div>

      <div className="absolute bottom-full left-0 -mb-px rounded-t-lg border-x border-t border-white/10 bg-neutral-950 px-2 py-1 shadow-lg">
        <span className="text-[10px] font-bold text-white">
          Rankings
        </span>
      </div>
    </div>
  );
}
