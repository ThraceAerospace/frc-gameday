import GamedayWidget from "@/components/gameday/GamedayWidget";

export default async function GamedayPage({ params, searchParams }) {
  const { event } = await params; 
  const sp = await searchParams; 

  const team = sp?.team || null;

  console.log("EVENT:", event);
  console.log("TEAM:", team);


  return (
    console.log("Rendering GamedayPage with:", { event, team }) || 
    <GamedayWidget event={event} team={team} />
  );
}