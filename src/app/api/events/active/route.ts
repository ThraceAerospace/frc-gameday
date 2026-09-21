import { TBA } from "@/lib/tbaService";
import type { TBAEvent } from "@/lib/tba/types";

type EventState = "upcoming" | "in_progress" | "complete";

type ActiveEvent = Pick<
  TBAEvent,
  | "key"
  | "name"
  | "short_name"
  | "event_type_string"
  | "city"
  | "state_prov"
  | "country"
  | "start_date"
  | "end_date"
> & {
  state: EventState;
  flags: {
    hasDivisions: boolean;
    isPastStart: boolean;
  };
};

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

function getEventWeight(event: ActiveEvent): number {
  return (
    (event.flags.hasDivisions ? 1000 : 0) +
    (event.flags.isPastStart ? 10 : 0)
  );
}

export async function GET() {
  try {
    const events = await TBA.getEvents(new Date().getFullYear());
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
      .map(
        ({
          event,
          start,
          end,
        }): ActiveEvent => ({
          key: event.key,
          name: event.name,
          short_name: event.short_name,
          event_type_string: event.event_type_string,
          city: event.city,
          state_prov: event.state_prov,
          country: event.country,
          start_date: event.start_date,
          end_date: event.end_date,

          state: getEventState(start, end, now),

          flags: {
            hasDivisions: (event.division_keys?.length ?? 0) > 0,
            isPastStart: start <= now,
          },
        })
      );

    const stateOrder: Record<EventState, number> = {
      in_progress: 0,
      upcoming: 1,
      complete: 2,
    };

    enriched.sort(
      (a, b) =>
        stateOrder[a.state] - stateOrder[b.state] ||
        a.start_date.localeCompare(b.start_date) ||
        getEventWeight(b) - getEventWeight(a)
    );

    return Response.json(enriched);
  } catch (error) {
    console.error("Failed to fetch active events:", error);

    return Response.json([], {
      status: 200,
    });
  }
}