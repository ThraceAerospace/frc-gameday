"use client";

export default function Record({ status }) {
  //console.log("Record render with status", status);
  if (!status) return <span className="text-gray-400 text-sm">No Matches</span>;

  const finalsRecord = status?.playoff?.level === "f" && status?.playoff.current_level_record
  const playoffRecord = status?.playoff?.record;
  const qualRecord = status?.qual?.ranking?.record;

  const record = finalsRecord || playoffRecord || qualRecord;

  if (!record) return <span>-W -L </span>;

  return (
    <div className="text-sm">
      <span className="text-green-400 font-bold p-1">{record.wins}W</span>
      <span className="text-red-400 font-bold p-1">{record.losses}L</span>
      {record.ties > 0 && (
        <span className="text-gray-300 font-bold p-1">{record.ties}T</span>
      )}
    </div>
  );
}