export function formatEventTime(timestampSeconds, eventTimeZone) {
  const date = new Date(timestampSeconds * 1000);

  const eventDate = new Date(
    date.toLocaleString("en-US", { timeZone: eventTimeZone })
  );

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: eventTimeZone })
  );

  const isDifferentDay =
    eventDate.toDateString() !== now.toDateString();

  const time = eventDate.toLocaleTimeString("en-US", {
    timeZone: eventTimeZone,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  });

  const cleanedTime = time//.replace(/\s?(AM|PM)/i, (_, p1) =>
    //p1[0].toLowerCase()
  //);

  if (!isDifferentDay) {
    return cleanedTime;
  }

  const day = eventDate.toLocaleDateString("en-US", {
    timeZone: eventTimeZone,
    weekday: "short",
  });

  return `${day} ${cleanedTime}`;
}

export function formatEventDate(timestampSeconds, timeZone) {
  const date = new Date(timestampSeconds * 1000);

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "2-digit",
  }).format(date);
}

export function getEventNow(timeZone) {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone })
  );
}