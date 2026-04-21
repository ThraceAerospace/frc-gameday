import { TBA } from "@/lib/tbaService";
import MultiviewClient from "../../../../components/multiview/MultiviewClient";
import GamedayWidget from "@/components/gameday/GamedayWidget";

function normalizeTeams(param) {
  if (!param) return [];
  return Array.isArray(param) ? param : [param];
}

export default async function DivisionalEvent({ params, searchParams }) {
  const { parentEvent } = await params;

  const sp = await searchParams;
  const teams = normalizeTeams(sp.team);

  const parent = await TBA.getEvent(parentEvent);
  const divisionKeys = parent?.division_keys || [];

  const divisions = [];
  for (const key of divisionKeys) {
    const division = await TBA.getEvent(key);
    divisions.push(division);
  }

  return (
    <MultiviewClient>
      {/* Divisions */}
      {divisions.map((division) => (
        <GamedayWidget
          key={division.key}
          event={division.key}
          team={teams[0]}
        />
      ))}
      {/* Parent event */}
      <GamedayWidget
        key={parent.key}
        event={parent.key}
        team={teams[0]}
      />
    </MultiviewClient>
  );
}