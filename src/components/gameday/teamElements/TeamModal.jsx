"use client";

import { useState, useMemo, useEffect } from "react";
import Record from "@/components/gameday/teamElements/Record";
import Rank from "@/components/gameday/teamElements/Rank";

export default function TeamModal({
  open,
  setOpen,
  teams,
  teamsStatuses,
  playoffAlliances,
  activeTeam,
  addTrackedTeam,
  removeTrackedTeam
}) {

  // ESC to close
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);


  const [search, setSearch] = useState("");

  // Reset search when modal opens
  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  // Sort + filter teams (without mutating props)
  const filteredTeams = useMemo(() => {
    const query = search.toLowerCase();

    return [...teams]
      .sort((a, b) => a.team_number - b.team_number)
      .filter((t) => {
        return (
          t.team_number.toString().includes(query) ||
          t.nickname?.toLowerCase().includes(query) ||
          t.city?.toLowerCase().includes(query) ||
          t.state_prov?.toLowerCase().includes(query) ||
          t.country?.toLowerCase().includes(query)
        );
      });
  }, [teams, search]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-neutral-900 w-[90%] max-w-md rounded-lg max-h-[70vh] flex flex-col">

        {/* Sticky Header */}
        <div className="sticky top-0 bg-neutral-900 z-10 px-4 pt-4 pb-2 rounded-t-lg">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-white font-semibold">Select Teams</h2>

            <button
              onClick={() => setOpen(false)}
              className="text-white text-sm"
            >
              ✕
            </button>
          </div>

          <input
            type="text"
            placeholder="Search teams by number, name, or location..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 rounded bg-neutral-800 text-white placeholder-neutral-400 outline-none"
          />
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 pt-2 custom-scrollbar">
          <div>
            <nav className="flex flex-col gap-2 max-w-[95%] mx-auto">
              {/* All Teams Button */}
              <button
                onClick={() => {
                  activeTeam.forEach((a) => removeTrackedTeam(a));
                  setOpen(false);
                }}
                className={`w-full px-3 py-1 rounded text-sm ${
                  activeTeam.length === 0
                    ? "bg-white text-black"
                    : "bg-neutral-800 text-white hover:bg-neutral-700"
                }`}
              >
                All Teams
              </button>

              {/* Teams List */}
              {filteredTeams.map((t) => (
                <button
                  key={t.key}
                  onClick={() => {
                    if (activeTeam.includes(t.key)) {
                      removeTrackedTeam(t.key);
                    } else {
                      addTrackedTeam(t.key);
                    }
                  }}
                  className={`w-full text-left px-3 py-2 rounded transition ${
                    activeTeam.includes(t.key)
                      ? "bg-blue-700 text-white"
                      : "bg-neutral-800 text-white hover:bg-neutral-700"
                  }`}
                >
                  <div>{t.team_number} — {t.nickname}</div>
                  <div className="flex gap-2 text-xs">
                    <Rank status={teamsStatuses[t.key]} />
                    <Record status={teamsStatuses[t.key]} />
                  </div>
                  <span className="text-xs text-gray-300">{`${t.city ? t.city + ", " : ""}${t.state_prov ? t.state_prov + ", " : ""}${t.country ? t.country : ""}` || ""}</span>
                </button>
              ))}
            </nav>
          </div>
        </div>

      </div>
    </div>
  );
}