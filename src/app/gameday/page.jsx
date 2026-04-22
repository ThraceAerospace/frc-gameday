import { TBA } from "@/lib/tbaService";
import MultiviewClient from "@/components/multiview/MultiviewClient";
import GamedayWidget from "@/components/gameday/GamedayWidget";

function normalizeParams(param) {
  if (!param) return [];
  return Array.isArray(param) ? param : [param];
}

export default async function DivisionalEvent({ params, searchParams }) {
  const { parentEvent } = await params;

  const sp = await searchParams;
  const teams = normalizeParams(sp.team);
  const eventKeys = normalizeParams(sp.event)
  const events = [];
  for (const key of eventKeys) {
    const event = await TBA.getEvent(key);
    const eventTeams = await TBA.getTeamsAtEvent(key);
    event['teams'] = eventTeams;
    events.push(event);
  }

  return (
    <MultiviewClient isDivisional={false}>
      {/* Divisions */}
      {events.map((event) => (
        <GamedayWidget
          key={event.key}
          event={event.key}
          team={teams[0]}
          eventName={event.short_name}
          isDivisional={true}
        />
      ))}
    </MultiviewClient>
  );
}