import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import { TBA } from "@/lib/tba/service";
import { TBAMatchSimple } from "@/lib/tba/types";

export default async function EventPage({
  params,
}: {
  params: Promise<{ event: string }>;
}) {
  const { event: eventKey } = await params;

  if (!eventKey) {
    return (
      <SiteShell events={[]}>
        <main className="min-h-full bg-slate-50 px-6 py-10 text-slate-900">
          <p className="text-slate-500">Missing event key.</p>
        </main>
      </SiteShell>
    );
  }

  let event;
  let matches;
  let navigationEvents;

  try {
    [event, matches, navigationEvents] = await Promise.all([
      TBA.getEvent(eventKey),
      TBA.getEventMatchesSimple(eventKey),
      TBA.getEvents(new Date().getFullYear()),
    ]);
  } catch {
    return (
      <SiteShell events={[]}>
        <main className="min-h-full bg-slate-50 px-6 py-10 text-slate-900">
          <div className="mx-auto max-w-5xl">
            <h1 className="text-2xl font-semibold">Event unavailable</h1>
            <p className="mt-2 text-slate-500">
              Could not load event <code>{eventKey}</code>.
            </p>
          </div>
        </main>
      </SiteShell>
    );
  }

  const location = [event.city, event.state_prov, event.country]
    .filter(Boolean)
    .join(", ");

  matches = [...matches].sort((a: TBAMatchSimple, b: TBAMatchSimple) => {
    const levelOrder: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
    return (levelOrder[a.comp_level] ?? 99) - (levelOrder[b.comp_level] ?? 99)
      || (a.set_number ?? 0) - (b.set_number ?? 0)
      || (a.match_number ?? 0) - (b.match_number ?? 0);
  });

  const dates =
    event.start_date && event.end_date
      ? event.start_date === event.end_date
        ? event.start_date
        : `${event.start_date} – ${event.end_date}`
      : event.start_date ?? event.end_date ?? null;

  return (
    <SiteShell events={navigationEvents} selectedEventKey={event.key}>
      <main className="min-h-full bg-slate-50 text-slate-900">
        <div className="mx-auto max-w-5xl px-6 py-10">
          <header className="border-b border-slate-200 pb-8">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div>
                <p className="font-mono text-sm text-slate-400">{event.key}</p>
                <h1 className="mt-2 text-3xl font-bold tracking-tight">{event.name}</h1>
                {event.short_name && event.short_name !== event.name && (
                  <p className="mt-1 text-lg text-slate-500">{event.short_name}</p>
                )}
              </div>
              <Link
                href={`/gameday?event=${event.key}`}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium transition hover:bg-slate-100"
              >
                Open Gameday
              </Link>
            </div>
          </header>

          <section className="mt-8">
            <h2 className="text-lg font-semibold">Event Information</h2>
            <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-2">
              <InfoItem label="Date" value={dates} />
              <InfoItem label="Location" value={location} />
              <InfoItem label="Venue" value={event.location_name} />
              <InfoItem label="Timezone" value={event.timezone} />
              <InfoItem label="Event Type" value={event.event_type_string ?? event.event_type} />
              <InfoItem label="District" value={event.district?.display_name} />
            </div>
          </section>

          <section className="mt-8">
            <h2 className="text-lg font-semibold">Links</h2>
            <div className="mt-4 flex flex-wrap gap-3">
              {event.website && <ExternalLink href={event.website} label="Event Website" />}
              <ExternalLink
                href={`https://www.thebluealliance.com/event/${event.key}`}
                label="The Blue Alliance"
              />
            </div>
          </section>

          <section className="mt-8">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold">Teams</h2>
              <Link
                href={`/event/${event.key}/teams`}
                className="text-sm text-slate-500 hover:text-slate-900"
              >
                View teams →
              </Link>
            </div>
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6">
              <p className="text-sm text-slate-400">Team listing coming soon.</p>
            </div>
          </section>

          <section className="mt-8">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold">Match Schedule</h2>
              <Link
                href={`/event/${event.key}/matches`}
                className="text-sm text-slate-500 hover:text-slate-900"
              >
                View all matches →
              </Link>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
              {matches.length === 0 ? (
                <div className="bg-white p-6">
                  <p className="text-sm text-slate-400">No matches are currently available.</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {matches.map((match: TBAMatchSimple) => (
                    <div
                      key={match.key}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 bg-white px-5 py-4"
                    >
                      <div className="min-w-20">
                        <p className="font-mono text-sm font-medium">{formatMatchName(match)}</p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {match.comp_level === "qm"
                            ? "Qualification"
                            : match.comp_level === "sf"
                              ? "Semifinal"
                              : match.comp_level === "f"
                                ? "Final"
                                : match.comp_level}
                        </p>
                      </div>
                      <div className="grid min-w-0 grid-cols-2 gap-6 text-sm sm:grid-cols-4">
                        <Alliance label="Red" teams={match.alliances?.red?.team_keys} />
                        <Alliance label="Blue" teams={match.alliances?.blue?.team_keys} />
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-slate-600">{formatMatchTime(match.time)}</p>
                        {match.actual_time != null && (
                          <p className="mt-0.5 text-xs text-slate-400">Played</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </SiteShell>
  );
}

function InfoItem({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="bg-white px-5 py-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-1 text-sm text-slate-600">{value ?? "—"}</dd>
    </div>
  );
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
    >
      {label}
    </a>
  );
}

function Alliance({ label, teams }: { label: string; teams?: string[] }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 truncate font-mono text-xs text-slate-600">
        {teams?.length ? teams.map((team) => team.replace(/^frc/, "")).join(" · ") : "—"}
      </p>
    </div>
  );
}

function formatMatchName(match: {
  comp_level?: string;
  set_number?: number;
  match_number?: number;
}) {
  if (match.comp_level === "qm") return `Q${match.match_number ?? "—"}`;
  if (match.comp_level === "sf") {
    return `SF${match.set_number ?? "—"}-${match.match_number ?? "—"}`;
  }
  if (match.comp_level === "f") return `F${match.match_number ?? "—"}`;

  return [match.comp_level?.toUpperCase(), match.set_number, match.match_number]
    .filter((value) => value != null)
    .join("-");
}

function formatMatchTime(time?: number | null) {
  if (time == null) return "—";

  return new Date(time * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
