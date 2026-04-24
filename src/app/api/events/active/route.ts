import { TBA } from "@/lib/tbaService";

export const revalidate = 36000;
type EventState = "upcoming" | "in_progress" | "complete";

function getEventState(event: any): "upcoming" | "in_progress" | "complete" {
  const now = new Date();
  const start = new Date(event.start_date);
  const end = new Date(event.end_date);

  // 🟥 definitely finished
  if (now > end) {
    return "complete";
  }

  // 🟡 not started yet
  if (now < start) {
    return "upcoming";
  }

  // 🔵 currently in window (regardless of match data)
  return "in_progress";
}

function getEventWeight(event: any): number {
  const f = event.flags;

  return (
    (f.hasDivisions ? 1000 : 0) +      // Parent event of Divisions should be shown first
    (f.hasPlayedMatches ? 100 : 0) +   // live activity
    (f.hasMatches ? 10 : 0) +          // scheduled data exists
    (f.isPastStart ? 1 : 0)            // weakest signal
  );
}

export async function GET() {
    const year = new Date().getFullYear();

    const events:any = await TBA.getEvents(year);

    const enriched = await Promise.all(
        events.map(async (event: any) => {
            const matches:any = await TBA.getEventMatchesSimple(event.key);

            const hasMatches = matches.length > 0;
            const hasPlayedMatches = matches.some((m: { actual_time: number; }) => m.actual_time !== null);
            const state = getEventState(event);
            const hasDivisions = event.division_keys.length > 0
            const start = new Date(event.start_date);
            const now = new Date();

            const isPastStart = start <= now;

            return {
            ...event,
            state,
            flags: {
                isPastStart,
                hasDivisions,
                hasMatches,
                hasPlayedMatches,
            },
            matches
            };
        })
  );

  // optional: sort by importance (live first)
  enriched.sort((a, b) => {
    const order:any = { in_progress: 0, upcoming: 1, complete: 2 };
    return (order[a.state] - order[b.state]);
  });
  enriched.sort( (a,b) => {
    return getEventWeight(b) - getEventWeight(a)
  });
  enriched.sort( (a,b) => {
    return (new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
  });

  return Response.json(enriched);
}