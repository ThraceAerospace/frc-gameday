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
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-neutral-900 w-[90%] max-w-md rounded-lg p-4 max-h-[70vh] overflow-y-auto">

        <div className="flex justify-between items-center mb-3">
          <h2 className="text-white font-semibold">Select Teams</h2>

          <button
            onClick={() => setOpen(false)}
            className="text-white text-sm"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-2">
        <button
        onClick={() => {activeTeam.forEach((a) => removeTrackedTeam(a)); setOpen(false)}}
        className={`px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-sm ${
               activeTeam.length === 0
                  ? "bg-white text-black"
                  : "bg-neutral-800 text-white hover:bg-neutral-700"
              }`}
        >
        All Teams
        </button>
          {/* {playoffAlliances.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                addTrackedTeam(t.picks);
                setOpen(false);
              }}
              className={`text-left px-3 py-2 rounded transition ${
                activeTeam.includes(t.picks)
                  ? "bg-white text-black"
                  : "bg-neutral-800 text-white hover:bg-neutral-700"
              }`}
            >
              {t.name} — {t.picks.join(" ").replace(/frc/g, "")}
            </button>
          ))} */}

          {teams.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                if (activeTeam.includes(t.key)) removeTrackedTeam(t.key);
                else addTrackedTeam(t.key);
              }}
              className={`text-left px-3 py-2 rounded transition ${
               activeTeam.includes(t.key)
                  ? "bg-white text-black"
                  : "bg-neutral-800 text-white hover:bg-neutral-700"
              }`}
            >
              {t.team_number} — {t.nickname} <span className="flex gap-2 text-xs"><Rank status={teamsStatuses[t.key]} /> <Record status={teamsStatuses[t.key]} /></span>
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}