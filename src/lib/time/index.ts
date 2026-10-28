export function formatEventTime(timestampSeconds: number | null | undefined, eventTimeZone?: string | null): string {
  if (!timestampSeconds) return "Time TBD";

  const timeZone = eventTimeZone || "UTC";
  const date = new Date(timestampSeconds * 1000);
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value])
  );

  const nowParts = Object.fromEntries(
    formatter.formatToParts(now).map(({ type, value }) => [type, value])
  );

  const sameDay =
    parts.year === nowParts.year &&
    parts.month === nowParts.month &&
    parts.day === nowParts.day;

  const time = `${parts.hour}:${parts.minute} ${parts.timeZoneName}`;

  return sameDay ? time : `${parts.weekday} ${time}`;
}

export function formatEventDate(timestampSeconds: number, timeZone: string): string {
  const date = new Date(timestampSeconds * 1000);

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "2-digit",
  }).format(date);
}

export function getEventNow(timeZone: string): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone })
  );
}

export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function dumbDateString(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  return `${months[month - 1]} ${day}, ${year}`;
}

/** Format a TBA date range in the viewer's locale, without UTC date shifts. */
export function formatEventDateRange(
  startDate: string,
  endDate: string,
  locale = "en-US",
): string {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  const english = locale.toLowerCase().startsWith("en");

  const formatDay = (value: Date) => {
    if (!english) {
      return new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
      }).format(value);
    }

    const month = new Intl.DateTimeFormat(locale, { month: "short" }).format(value);
    const day = value.getDate();
    const suffix =
      day % 100 >= 11 && day % 100 <= 13
        ? "th"
        : day % 10 === 1
          ? "st"
          : day % 10 === 2
            ? "nd"
            : day % 10 === 3
              ? "rd"
              : "th";

    return `${month} ${day}${suffix}`;
  };

  if (startDate === endDate) {
    return `${formatDay(start)}, ${start.getFullYear()}`;
  }

  return `${formatDay(start)} to ${formatDay(end)}, ${end.getFullYear()}`;
}
