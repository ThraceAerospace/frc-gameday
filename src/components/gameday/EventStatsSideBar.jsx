// filepath: /home/logan/Documents/frc-gameday/src/components/gameday/EventStatsSideBar.jsx
"use client";

import { useEffect, useState } from "react";
import { compLevelShortName } from "@/lib/tbaFormatters";

export default function EventStatsSideBar({
    teamStatuses,
    playoffAlliances,
}) {
    const [displayMode, setDisplayMode] = useState("rankings"); // "rankings" or "alliances"

    // Show alliances if we have them and event is in playoffs
    const showAlliances =
        playoffAlliances && playoffAlliances.length > 0;

    // Sort teams by rank
    const rankedTeams = teamStatuses
        ? Object.entries(teamStatuses)
            .map(([team_key, team]) => ({
                team_key,
                rank: team?.qual?.ranking.rank || null,
                wins: team?.qual?.ranking.record.wins || 0,
                losses: team?.qual?.ranking.record.losses || 0,
            }))
            .sort((a, b) => (a.rank || 9999) - (b.rank || 9999))
        : [];

    return (
        <div className="w-full h-full bg-neutral-900 border-l border-neutral-800 flex flex-col text-white overflow-hidden">
            {/* HEADER */}
            <div className="shrink-0 border-b border-neutral-800 p-3">
                <div className="flex gap-2">
                    <button
                        onClick={() => setDisplayMode("rankings")}
                        className={`px-3 py-1 rounded text-sm transition-colors ${
                            displayMode === "rankings"
                                ? "bg-blue-600 hover:bg-blue-700"
                                : "bg-neutral-800 hover:bg-neutral-700"
                        }`}
                    >
                        Rankings
                    </button>
                    {showAlliances && (
                        <button
                            onClick={() => setDisplayMode("alliances")}
                            className={`px-3 py-1 rounded text-sm transition-colors ${
                                displayMode === "alliances"
                                    ? "bg-blue-600 hover:bg-blue-700"
                                    : "bg-neutral-800 hover:bg-neutral-700"
                            }`}
                        >
                            Alliances
                        </button>
                    )}
                </div>
            </div>

            {/* CONTENT */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {displayMode === "rankings" ? (
                    // RANKINGS VIEW
                    <div className="space-y-1 p-2">
                        {rankedTeams.length > 0 ? (
                            rankedTeams.map((team) => (
                                <div
                                    key={team.team_key}
                                    className="flex items-center gap-2 p-2 bg-neutral-800 rounded hover:bg-neutral-700 transition-colors text-sm"
                                >
                                    <div className="w-8 font-bold text-blue-400 shrink-0">
                                        {team.rank || ""}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-semibold truncate">
                                            {team.team_key.split("frc")[1]}
                                        </div>
                                    </div>
                                    <div className="text-xs text-neutral-400 shrink-0">
                                        {team.wins}W-{team.losses}L
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="text-center text-neutral-500 py-8">
                                No team data available
                            </div>
                        )}
                    </div>
                ) : (
                    // ALLIANCES VIEW
                    <div className="space-y-2 p-2">
                        {playoffAlliances.sort((a, b) => b.status.record.wins - a.status.record.wins).map((alliance, idx) => {
                            const isEliminated = alliance.status?.status === "eliminated";
                            const statusText = alliance.status
                                ? alliance.status.status === "won"
                                    ? "Winners"
                                    : alliance.status.status === "eliminated"
                                        ? alliance.status.level === "f" ? "Finalists" : `Eliminated in ${alliance.status.double_elim_round ||  `the ${compLevelShortName(alliance.status.level)}` || "unknown"}`
                                        : alliance.status.status
                                : "";
                            return (
                                <div
                                    key={idx}
                                    className="bg-neutral-800 rounded p-2 space-y-1"
                                >
                                    <div className="text-xs font-bold text-white-400">
                                        {alliance.name}
                                        {statusText && (
                                            <span className={`ml-2 ${isEliminated ? "text-red-400" : "text-green-400"}`}>
                                                {statusText}
                                            </span>
                                        )}
                                        <span className="ml-2 text-neutral-400">
                                            {alliance.status?.record?.wins || 0}W-{alliance.status?.record?.losses || 0}L
                                        </span>
                                    </div>
                                    <div className="space-y-1 flex flex-row">
                                        {alliance.picks?.map((teamKey) => (
                                            
                                            <div
                                                key={teamKey}
                                                className="text-sm pl-2 text-neutral-300"
                                            >
                                                {teamKey.split("frc")[1]}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}