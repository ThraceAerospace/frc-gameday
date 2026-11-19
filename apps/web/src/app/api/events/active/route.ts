import { getCanonicalEventDiscovery } from "@/lib/events/serverSnapshot";
import type { FieldViewEvent } from "@fieldview/domain";

type EventState = "upcoming" | "in_progress" | "complete";

type ActiveEvent = { event: FieldViewEvent; state: EventState };

function parseEventDate(
  dateString: string,
  timezone: string,
  endOfDay = false
): Date {
  const [year, month, day] = dateString.split("-").map(Number);

  const utcGuess = Date.UTC(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0
  );

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(utcGuess))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  const localAsUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  const offset = localAsUTC - utcGuess;

  return new Date(utcGuess - offset);
}

function getEventState(
  start: Date,
  end: Date,
  now: Date
): EventState {
  if (now > end) {
    return "complete";
  }

  if (now < start) {
    return "upcoming";
  }

  return "in_progress";
}

export async function GET() {
  try {
    const events = await getCanonicalEventDiscovery(new Date().getUTCFullYear());
    if (!events) return Response.json({ error: "Event discovery snapshot unavailable" }, { status: 503 });
    const now = new Date();

    const enriched = events
      .map((event) => {
        const timezone = event.timezone ?? "UTC";

        const start = parseEventDate(
          event.start_date,
          timezone
        );

        const end = parseEventDate(
          event.end_date,
          timezone,
          true
        );

        return {
          event,
          start,
          end,
          timezone,
        };
      })
      .filter(({ start, end }) => start >= now || end >= now)
      .map(({ event, start, end }): ActiveEvent => ({
        event,
        state: getEventState(start, end, now),
      }));

    const stateOrder: Record<EventState, number> = {
      in_progress: 0,
      upcoming: 1,
      complete: 2,
    };

    enriched.sort(
      (a, b) =>
        stateOrder[a.state] - stateOrder[b.state] ||
        a.event.start_date.localeCompare(b.event.start_date) ||
        (b.event.division_keys?.length ?? 0) - (a.event.division_keys?.length ?? 0)
    );

    return Response.json(enriched.map(({ event }) => event));
  } catch (error) {
    console.error("Failed to fetch active events:", error);

    return Response.json({ error: "Event discovery is temporarily unavailable" }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}