import { TBA } from "@/lib/tbaService";

export const revalidate = 3600; // ISR: revalidate every hour

type EventState = "upcoming" | "in_progress" | "complete";

function getEventState(event: any): EventState {
  const now = new Date();
  const start = new Date(event.start_date);
  const end = new Date(event.end_date);

  if (now > end) return "complete";
  if (now < start) return "upcoming";
  return "in_progress";
}

function getEventWeight(event: any): number {
  const f = event.flags;

  return (
    (f.hasDivisions ? 1000 : 0) +
    (f.isPastStart ? 10 : 0)
  );
}

export async function GET() {
  try {
    const year = new Date().getFullYear();

    // 🔹 Fetch events (build-time safe, but guarded)
    const events: any[] = await TBA.getEvents(year);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 🔹 Filter relevant events (ongoing or future)
    const filteredEvents = events.filter((e: any) => {
      const [sy, sm, sd] = e.start_date.split("-").map(Number);
      const [ey, em, ed] = e.end_date.split("-").map(Number);

      const start = new Date(sy, sm - 1, sd);
      const end = new Date(ey, em - 1, ed);

      return start >= today || (start <= today && end >= today);
    });

    // 🔹 Enrich (sync, no Promise.all needed)
    const now = new Date();

    const enriched = filteredEvents.map((event: any) => {
      const start = new Date(event.start_date);

      const state = getEventState(event);
      const hasDivisions = event.division_keys?.length > 0;
      const isPastStart = start <= now;

      return {
        key: event.key,
        name: event.name,
        start_date: event.start_date,
        end_date: event.end_date,
        state,
        flags: {
          hasDivisions,
          isPastStart,
        },
      };
    });

    // 🔹 Single stable sort (priority → date)
    const stateOrder: Record<EventState, number> = {
      in_progress: 0,
      upcoming: 1,
      complete: 2,
    };

    enriched.sort((a, b) => {
      return (
        stateOrder[a.state] - stateOrder[b.state] ||
        new Date(a.start_date).getTime() - new Date(b.start_date).getTime() ||
        getEventWeight(b) - getEventWeight(a)
      );
    });

    return Response.json(enriched);
  } catch (error) {
    console.error("Failed to fetch active events:", error);

    // ✅ Prevent build crash by returning fallback
    return Response.json([], { status: 200 });
  }
}