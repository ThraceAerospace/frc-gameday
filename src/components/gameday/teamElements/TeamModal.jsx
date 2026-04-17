export default function TeamModal({
  open,
  setOpen,
  teams,
  activeTeam,
  setActiveTeam
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-neutral-900 w-[90%] max-w-md rounded-lg p-4 max-h-[70vh] overflow-y-auto">

        <div className="flex justify-between items-center mb-3">
          <h2 className="text-white font-semibold">Select Team</h2>

          <button
            onClick={() => setOpen(false)}
            className="text-white text-sm"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {teams.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setActiveTeam(t.key);
                setOpen(false);
              }}
              className={`text-left px-3 py-2 rounded transition ${
                t.key === activeTeam
                  ? "bg-white text-black"
                  : "bg-neutral-800 text-white hover:bg-neutral-700"
              }`}
            >
              {t.team_number} — {t.nickname}
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}