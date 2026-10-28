"use client";

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function formatDate(value: string, locale: string, english: boolean): string {
  const date = parseLocalDate(value);
  if (!english) {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }

  const month = new Intl.DateTimeFormat(locale, { month: "short" }).format(date);
  const day = date.getDate();
  return `${month} ${day}${ordinal(day)}`;
}

export default function EventDateRange({
  startDate,
  endDate,
}: {
  startDate: string;
  endDate: string;
}) {
  const locale = typeof navigator === "undefined" ? "en-US" : navigator.language;
  const english = locale.toLowerCase().startsWith("en");
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);

  if (startDate === endDate) {
    return <>{formatDate(startDate, locale, english)}, {start.getFullYear()}</>;
  }

  return (
    <>
      {formatDate(startDate, locale, english)} to {formatDate(endDate, locale, english)}, {end.getFullYear()}
    </>
  );
}
