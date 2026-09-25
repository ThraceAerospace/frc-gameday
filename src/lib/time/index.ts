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

  const time = `${parts.hour}:${parts.minute}`;

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