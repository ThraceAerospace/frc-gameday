"use client";

import type { TBATeam } from "@/lib/tba/types";

export default function TeamAvatar({
  team,
  size = "lg",
}: {
  team: TBATeam;
  size?: "sm" | "lg";
}) {
  const avatar = team.media?.find(
    (media) =>
      media.type === "avatar" &&
      typeof media.details?.base64Image === "string" &&
      media.details.base64Image.length > 0,
  );

  const sizeClass = size === "sm" ? "h-8 w-8" : "h-20 w-20";

  if (!avatar?.details?.base64Image) {
    return (
      <div
        className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-100 font-mono font-black text-slate-400`}
        aria-hidden="true"
      >
        {team.team_number}
      </div>
    );
  }

  return (
    <img
      src={`data:image/png;base64,${avatar.details.base64Image}`}
      alt={`${team.team_number} team avatar`}
      className={`${sizeClass} shrink-0 rounded-xl border border-slate-200 bg-white object-contain p-1`}
    />
  );
}
