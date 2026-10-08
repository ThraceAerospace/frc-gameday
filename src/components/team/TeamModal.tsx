"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  TBATeam,
  TBATeamEventStatus,
} from "@/lib/tba/types";

import Rank from "./Rank";
import TeamRecord from "./Record";

type TeamModalProps = {
  open: boolean;
  onClose: () => void;
  teams?: TBATeam[];
  teamsStatuses?: globalThis.Record<
    string,
    TBATeamEventStatus | null
  >;
  trackedTeams?: string[];
  onToggle: (teamKey: string) => void;
};

export default function TeamModal({
  open,
  onClose,
  teams = [],
  teamsStatuses = {},
  trackedTeams = [],
  onToggle,
}: TeamModalProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }

    setQuery("");

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };

    window.addEventListener("keydown", close);

    return () => {
      window.removeEventListener("keydown", close);
    };
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return [...teams]
      .sort(
        (a, b) =>
          a.team_number - b.team_number,
      )
      .filter((team) => {
        if (!q) {
          return true;
        }

        return [
          team.team_number,
          team.nickname,
          team.city,
          team.state_prov,
          team.country,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
  }, [teams, query]);

  if (!open) {
    return null;
  }

  return (
    <div
      data-modal-layer
      className="modal-backdrop"
      onMouseDown={onClose}
    >
      <div
        className="modal-panel max-w-xl"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="border-b border-white/10 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold">
                Follow teams
              </div>

              <div className="text-xs text-neutral-500">
                {trackedTeams.length
                  ? `${trackedTeams.length} selected`
                  : "Showing the full event"}
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="text-neutral-500"
            >
              Close
            </button>
          </div>

          <input
            autoFocus
            value={query}
            onChange={(event) =>
              setQuery(event.target.value)
            }
            placeholder="Search team number or name…"
            className="mt-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none"
          />
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {filtered.map((team) => {
            const selected =
              trackedTeams.includes(team.key);

            const status =
              teamsStatuses[team.key];

            return (
              <button
                type="button"
                key={team.key}
                onClick={() =>
                  onToggle(team.key)
                }
                className={`mb-1 w-full rounded-xl border p-3 text-left ${
                  selected
                    ? "border-white bg-white text-black"
                    : "border-white/5 bg-white/[.025] hover:bg-white/[.06]"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-bold">
                    {team.team_number}
                  </span>

                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {team.nickname ||
                      "Unknown team"}
                  </span>

                  {selected && (
                    <span className="text-[10px] font-bold uppercase">
                      Following
                    </span>
                  )}
                </div>

                <div className="mt-1 flex gap-3 text-[10px] opacity-60">
                  <Rank status={status} />
                  <TeamRecord status={status} />

                  <span>
                    {[
                      team.city,
                      team.state_prov,
                      team.country,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
