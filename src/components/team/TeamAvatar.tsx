"use client";

import type { TBATeam } from "@/lib/tba/types";

export default function TeamAvatar({
  team,
  size = "lg",
}: {
  team: TBATeam;
  size?: "sm" | "lg";
}) {
  const sizeClass = size === "sm" ? "h-8 w-8" : "h-20 w-20";

  return (
    <div
      className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-100 font-mono font-black text-slate-400`}
      aria-label={`Team ${team.team_number}`}
    >
      {team.team_number}
    </div>
  );
}
