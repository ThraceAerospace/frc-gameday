"use client";

import { useEffect, useMemo, useRef } from "react";
import { useEffect, useMemo, useRef } from "react";
import type {
  TBAEliminationAlliance,
  TBAEventTeamStatuses,
} from "@/lib/tba/types";

type RankingsStripProps = {
  teamsStatuses: TBAEventTeamStatuses;
  playoffAlliances?: TBAEliminationAlliance[];
  playoffType?: number | null;
  trackedTeams?: string[];
  trackedTeams?: string[];
};

function recordLabel(
  record:
    | { wins?: number; losses?: number; ties?: number }
    | null
    | undefined,
) {
function recordLabel(
  record:
    | { wins?: number; losses?: number; ties?: number }
    | null
    | undefined,
) {
  if (!record) return "—";
  return (
    String(record.wins ?? 0) +
    "-" +
    String(record.losses ?? 0) +
    "-" +
    String(record.ties ?? 0)
  );
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

function allianceLabel(
  alliance: TBAEliminationAlliance,
  index: number,
) {
  return alliance.name || "Alliance " + String(index + 1);
}

const SWEEP_DELAY = 2500;
const SWEEP_PAUSE = 4000;
const SWEEP_INTERVAL = 90000;

export default function RankingsStrip({
  teamsStatuses,
  playoffAlliances = [],
  playoffType = null,
  trackedTeams = [],
}: RankingsStripProps) {
  const hasAlliances = playoffAlliances.length > 0;
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const contentKey = useMemo(
    () =>
      JSON.stringify({
        teamsStatuses,
        playoffAlliances,
        playoffType,
      }),
    [teamsStatuses, playoffAlliances, playoffType],
  );

  useEffect(() => {
    const scroller = scrollerRef.current;

    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) {
      return;
    }

    scroller.scrollLeft = 0;

    const distance =
      scroller.scrollWidth - scroller.clientWidth;

    const duration = Math.max(
      5000,
      Math.min(14000, distance * 8),
    );

    let animationFrame = 0;
    let startedAt: number | null = null;
    let pauseTimer: ReturnType<typeof setTimeout> | null =
      null;

    const animate = (now: number) => {
      if (startedAt === null) {
        startedAt = now;
      }

      const progress = Math.min(
        (now - startedAt) / duration,
        1,
      );

      scroller.scrollLeft = distance * progress;

      if (progress < 1) {
        animationFrame = requestAnimationFrame(animate);
      } else {
        pauseTimer = setTimeout(() => {
          scroller.scrollLeft = 0;
        }, 4000);
      }
    };

    pauseTimer = setTimeout(() => {
      animationFrame = requestAnimationFrame(animate);
    }, 2500);

    return () => {
      cancelAnimationFrame(animationFrame);

      if (pauseTimer) {
        clearTimeout(pauseTimer);
      }
    };
  }, [contentKey]);

  if (hasAlliances) {
    const currentAlliance =
      playoffAlliances.find(
        (alliance) =>
          alliance.status?.status === "playing",
      ) ??
      playoffAlliances.find(
        (alliance) => alliance.status,
      ) ??
      playoffAlliances[0];

    return (
      <div className="relative min-w-0 overflow-hidden border-t border-white/10 bg-neutral-950/95">
        <div
          ref={scrollerRef}
          className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar"
        >
        <div
          ref={scrollerRef}
          className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar"
        >
          <div className="flex h-full min-w-max items-center gap-1.5 px-2">
            {playoffAlliances.map((alliance, index) => {
              const status = alliance.status;

              const isTracked = alliance.picks.some(
                (team) =>
                  trackedTeams.includes(team) ||
                  trackedTeams.includes(
                    team.replace(/^frc/i, ""),
                  ),
              );

              return (
                <article
                  key={alliance.name ?? index}
                  className={[
                    "flex h-[34px] shrink-0 items-center gap-3 rounded-md border px-3",
                    isTracked
                      ? "border-b-2 border-b-white"
                      : "",
                    status?.status === "playing"
                      ? "border-white/20 bg-white/[0.08]"
                      : "border-zinc-800 bg-zinc-950",
                  ].join(" ")}
                >
                  <div className="flex flex-col justify-center">
                    <span className="text-[9px] font-bold uppercase tracking-wide text-neutral-400">
                      {allianceLabel(
                        alliance,
                        index,
                      )}
                    </span>

                    <span className="mt-0.5 text-[10px] font-semibold text-white">
                      {alliance.picks
                        .map((team) =>
                          team.replace(/^frc/i, ""),
                        )
                        .join(" · ")}
                    </span>
                  </div>

                  <div className="h-6 w-px bg-white/10" />

                  <div className="flex flex-col justify-center text-right">
                    <span className="font-mono text-[10px] text-neutral-300">
                      {playoffLevel(
                        alliance,
                        playoffType,
                      )}
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

  const entries = Object.entries(teamsStatuses)
    .map(([teamKey, status]) => ({
      teamKey,
      status,
    }))
    .filter(
      (entry) => entry.status?.qual?.ranking,
    )
    .sort(
      (a, b) =>
        (a.status!.qual!.ranking!.rank ??
          Number.MAX_SAFE_INTEGER) -
        (b.status!.qual!.ranking!.rank ??
          Number.MAX_SAFE_INTEGER),
    );

  const sortOrderName =
    Object.values(teamsStatuses).find(
      (status) =>
        status?.qual?.sort_order_info?.[0],
    )?.qual?.sort_order_info?.[0]?.name ?? "RP";

  return (
    <div className="relative min-w-0 overflow-hidden border-t border-white/10 bg-neutral-950/95">
      <div
        ref={scrollerRef}
        className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar"
      >
      <div
        ref={scrollerRef}
        className="h-[52px] overflow-x-auto overflow-y-hidden no-scrollbar"
      >
        {entries.length > 0 ? (
          <div className="flex h-full min-w-max items-center gap-1.5 px-2">
            {entries.map((entry) => {
              const isTracked =
                trackedTeams.includes(
                  entry.teamKey,
                ) ||
                trackedTeams.includes(
                  entry.teamKey.replace(/^frc/i, ""),
                );

              return (
                <article
                  key={entry.teamKey}
                  className={[
                    "flex h-[34px] shrink-0 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3",
                    isTracked
                      ? "border-b-2 border-b-white"
                      : "",
                  ].join(" ")}
                >
                  <span className="w-5 text-center font-mono text-[10px] font-bold text-white">
                    {entry.status!.qual!.ranking!
                      .rank ?? "—"}
                  </span>

                  <span className="font-mono text-[11px] font-bold text-white">
                    {entry.teamKey.replace(
                      /^frc/i,
                      "",
                    )}
                  </span>

                  <span className="h-5 w-px bg-white/10" />
                  <span className="h-5 w-px bg-white/10" />

                  <span className="font-mono text-[10px] text-neutral-400">
                    {sortOrderName}{" "}
                    {entry.status!.qual!.ranking!
                      .sort_orders?.[0] ?? "—"}
                  </span>

                  <span className="font-mono text-[10px] text-neutral-500">
                    {recordLabel(
                      entry.status!.qual!.ranking!
                        .record,
                    )}
                  </span>
                </article>
              );
            })}
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