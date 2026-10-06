"use client";

import type {
  TBAEliminationAlliance,
  TBAEventTeamStatuses,
} from "@/lib/tba/types";

type RankingsStripProps = {
  teamsStatuses: TBAEventTeamStatuses;
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
  teamsStatuses,
  playoffAlliances = [],
  playoffType = null,
}: RankingsStripProps) {
  const hasAlliances = playoffAlliances.length > 0;\n  const scrollerRef = useRef<HTMLDivElement | null>(null);\n  const contentKey = useMemo(\n    () => JSON.stringify({ teamsStatuses, playoffAlliances, playoffType }),\n    [teamsStatuses, playoffAlliances, playoffType],\n  );\n\n  useEffect(() => {\n    const scroller = scrollerRef.current;\n    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;\n\n    scroller.scrollLeft = 0;\n    const distance = scroller.scrollWidth - scroller.clientWidth;\n    const duration = Math.max(5000, Math.min(14000, distance * 8));\n    let animationFrame = 0;\n    let startedAt: number | null = null;\n    let pauseTimer: ReturnType<typeof setTimeout> | null = null;\n\n    const animate = (now: number) => {\n      if (startedAt === null) startedAt = now;\n      const progress = Math.min((now - startedAt) / duration, 1);\n      scroller.scrollLeft = distance * progress;\n\n      if (progress < 1) {\n        animationFrame = requestAnimationFrame(animate);\n      } else {\n        pauseTimer = setTimeout(() => {\n          scroller.scrollLeft = 0;\n        }, 4000);\n      }\n    };\n\n    pauseTimer = setTimeout(() => {\n      animationFrame = requestAnimationFrame(animate);\n    }, 2500);\n\n    return () => {\n      cancelAnimationFrame(animationFrame);\n      if (pauseTimer) clearTimeout(pauseTimer);\n    };\n  }, [contentKey]);

  if (hasAlliances) {
    const currentAlliance =
      playoffAlliances.find((alliance) => alliance.status?.status === "playing") ??
      playoffAlliances.find((alliance) => alliance.status) ??
      playoffAlliances[0];

    return (
      <div className="relative min-w-0 overflow-hidden border-t border-white/10 bg-neutral-950/95">
        <div ref={scrollerRef} className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar">
          <div className="flex h-full min-w-max items-center gap-1.5 px-2">
            {playoffAlliances.map((alliance, index) => {
              const status = alliance.status;

              return (
                <article
                  key={alliance.name ?? index}
                  className={[
                    "flex h-[34px] shrink-0 items-center gap-3 rounded-md border px-3",\n                    isTracked ? "border-b-2 border-b-white" : "",
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
                    {/* <span className="text-[9px] uppercase tracking-wide text-neutral-500">
                      {playoffType === 10 ? "DE Round" : "Level"}
                    </span> */}
                    <span className="font-mono text-[10px] text-neutral-300">
                      {playoffLevel(alliance, playoffType)}
                    </span>
                    <span className="font-mono text-[10px] text-neutral-300">
                      {recordLabel(status?.record)}
                    </span>
                  </div>

                  {/* <div className="flex flex-col justify-center text-right">
                    <span className="text-[9px] uppercase tracking-wide text-neutral-500">
                      Record
                    </span>
                    <span className="font-mono text-[10px] text-neutral-300">
                      {recordLabel(status?.record)}
                    </span>
                  </div> */}
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

  const entries = Object.entries(teamsStatuses)
    .map(([teamKey, status]) => ({ teamKey, status }))
    .filter((entry) => entry.status?.qual?.ranking)
    .sort((a, b) => (a.status!.qual!.ranking!.rank ?? Number.MAX_SAFE_INTEGER) - (b.status!.qual!.ranking!.rank ?? Number.MAX_SAFE_INTEGER));

  const sortOrderName = Object.values(teamsStatuses).find((status) => status?.qual?.sort_order_info?.[0])?.qual?.sort_order_info?.[0]?.name ?? "RP";

  return (
    <div className="relative min-w-0 overflow-hidden border-t border-white/10 bg-neutral-950/95">
      <div className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar">
        {entries.length > 0 ? (
          <div className="flex h-full min-w-max items-center gap-1.5 px-2">
            {entries.map((entry) => (
              <article
                key={entry.teamKey}
                className="flex h-[34px] shrink-0 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3"
              >
                <span className="w-5 text-center font-mono text-[10px] font-bold text-white">
                  {entry.status!.qual!.ranking!.rank ?? "—"}
                </span>

                <span className="font-mono text-[11px] font-bold text-white">
                  {entry.teamKey.replace(/^frc/i, "")}
                </span>

                <span className="h-5 w-px bg-white/10" />

                <span className="font-mono text-[10px] text-neutral-400">
                  {sortOrderName} {entry.status!.qual!.ranking!.sort_orders?.[0] ?? "—"}
                </span>

                <span className="font-mono text-[10px] text-neutral-500">
                  {recordLabel(entry.status!.qual!.ranking!.record)}
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
