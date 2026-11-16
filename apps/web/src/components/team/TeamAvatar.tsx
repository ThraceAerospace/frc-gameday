"use client";

import Image from "next/image";
import type { TBATeam, TBATeamAvatar } from "@/lib/tba/types";

export default function TeamAvatar({
  team,
  avatar,
  size = "lg",
}: {
  team: TBATeam;
  avatar?: TBATeamAvatar | null;
  size?: "sm" | "lg";
}) {
  const sizeClass = size === "sm" ? "h-8 w-8" : "h-20 w-20";
  const dimension = size === "sm" ? 32 : 80;
  const image = avatar?.details?.base64Image;

  return (
    <div
      className={`flex ${sizeClass} shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-100 font-mono font-black text-slate-400`}
      aria-label={`Team ${team.team_number}`}
    >
      {image ? (
        <Image
          src={`data:image/png;base64,${image}`}
          alt={`Team ${team.team_number} avatar`}
          width={dimension}
          height={dimension}
          unoptimized
          className="h-full w-full object-contain"
        />
      ) : (
        team.team_number
      )}
    </div>
  );
}
