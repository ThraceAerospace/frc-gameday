import { TBA } from "@/lib/tbaService";
import MultiviewClient from "../../../../components/multiview/MultiviewClient";

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
  var divisions = [];
  for (const key of divisionKeys) {
    const division = await TBA.getEvent(key);
    //const divisionTeams = await TBA.getTeamsAtEvent(key);
   // division.teams = divisionTeams.map(t => t.key);
    divisions.push(division);
  }

  console.log("EVENT:", parentEvent);
  console.log("TEAMS:", teams);
  console.log("DIVISION KEYS:", divisionKeys);
  console.log("DIVISIONS:", divisions);

return (
  <MultiviewClient
    parentEvent={parent}
    teams={teams}
    divisionKeys={divisionKeys}
    divisions={divisions}
  />
);
}
