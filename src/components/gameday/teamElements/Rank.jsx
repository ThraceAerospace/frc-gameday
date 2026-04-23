"use client";

export default function TeamRank({ status }) {
  if (!status) {
    return (
      <div className="text-gray-400 text-sm">
        No Rank
      </div>
    );
  }
  
  const isPlayoffs = !!status?.playoff;
  const isQuals = !!status?.qual?.ranking;
  //console.log("TeamRank render with status", status, isPlayoffs, isQuals);


  // ------------------------
  // PLAYOFFS
  // ------------------------
  if (isPlayoffs) {
    const allianceName = status?.alliance?.name
      ? status.alliance.name
      : "";

    const round = status?.playoff?.double_elim_round
      ? status.playoff.double_elim_round
      : status?.playoff?.level
      ? status.playoff.level.toUpperCase()
      : "PLAYOFFS";

    const isEliminated = status?.playoff?.status === "eliminated";

    return (
      <div className="text-sm flex items-center gap-2">
        <span className="font-semibold">
          {allianceName || "?"}
        </span>

        <span className="text-gray-500">|</span>

        {isEliminated ? (
          <span className="text-red-400 font-semibold">
            {round}
          </span>
        ) : (
          <span className="text-white-300 font-semibold">
            {round}
          </span>
        )}
      </div>
    );
  } else if (isQuals) {
  // ------------------------
  // QUALIFICATIONS
  // ------------------------
    const rank = status.qual?.ranking?.rank;
    const total = status.qual?.num_teams;

    return (
        <div className="font-semibold text-sm">
          <span className="text-white-300">Rank:</span> {rank ?? "?"} / {total ?? "?"}
        </div>
    );
  }
  // ------------------------
  // FALLBACK
  // ------------------------
  return (
    <div className="text-gray-400 text-sm">
      No Rank
    </div>
  );
}