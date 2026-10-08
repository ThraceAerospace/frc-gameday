import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import TeamAvatar from "@/components/team/TeamAvatar";
import TeamEventMatches from "@/components/team/TeamEventMatches";
import TeamSeasonSelector from "@/components/team/TeamSeasonSelector";
import { TBA } from "@/lib/tba/service";
import type { TBAEventSimple, TBAMatch } from "@/lib/tba/types";

function normalizeTeamKey(value: string): string {
  return value.startsWith("frc") ? value : `frc${value}`;
}

function sortEvents(a: TBAEventSimple, b: TBAEventSimple) {
  return (
    a.start_date.localeCompare(b.start_date) ||
    a.name.localeCompare(b.name) ||
    a.key.localeCompare(b.key, undefined, { numeric: true })
  );
}

function sortMatches(a: TBAMatch, b: TBAMatch) {
  return (
    (a.time ?? a.actual_time ?? Infinity) - (b.time ?? b.actual_time ?? Infinity) ||
    (a.comp_level === "qm" ? 0 : 1) - (b.comp_level === "qm" ? 0 : 1) ||
    (a.set_number ?? 0) - (b.set_number ?? 0) ||
    (a.match_number ?? 0) - (b.match_number ?? 0)
  );
}

function getTeamResult(match: TBAMatch, teamKey: string) {
  const red = match.alliances?.red;
  const blue = match.alliances?.blue;
  const isRed = red?.team_keys?.includes(teamKey) ?? false;
  const alliance = isRed ? red : blue;
  const opponent = isRed ? blue : red;

  if (!alliance || !opponent || alliance.score < 0 || opponent.score < 0) {
    return "Upcoming";
  }

  if (alliance.score > opponent.score) return "Win";
  if (alliance.score < opponent.score) return "Loss";
  return "Tie";
}

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  const { team: rawTeam } = await params;
  const search = await searchParams;
  const teamKey = normalizeTeamKey(rawTeam);
  const currentYear = new Date().getFullYear();

  const [team, districts, allEvents] = await Promise.all([
    TBA.getTeam(teamKey),
    TBA.getTeamDistricts(teamKey),
    TBA.getEvents(currentYear),
  ]);

  const years = Array.from(
    { length: currentYear - (team.rookie_year ?? currentYear) + 1 },
    (_, index) => currentYear - index,
  );
  const requestedYear = Number(
    Array.isArray(search.year) ? search.year[0] : search.year,
  );
  const year = years.includes(requestedYear) ? requestedYear : currentYear;

  const events = await TBA.getTeamEvents(teamKey, year);
  const sortedEvents = [...events].sort(sortEvents);

  const eventMatches = await Promise.all(
    sortedEvents.map(async (event) => ({
      event,
      matches: (await TBA.getTeamMatches(teamKey, event.key)).sort(sortMatches),
    })),
  );

  const matches = eventMatches.flatMap(({ event, matches }) =>
    matches.map((match) => ({ event, match })),
  );

  const completedMatches = matches.filter(({ match }) => {
    const red = match.alliances?.red?.score ?? -1;
    const blue = match.alliances?.blue?.score ?? -1;
    return red >= 0 && blue >= 0;
  });

  const wins = completedMatches.filter(
    ({ match }) => getTeamResult(match, teamKey) === "Win",
  ).length;
  const losses = completedMatches.filter(
    ({ match }) => getTeamResult(match, teamKey) === "Loss",
  ).length;
  const ties = completedMatches.filter(
    ({ match }) => getTeamResult(match, teamKey) === "Tie",
  ).length;

  const district = districts.find((entry) => entry.year === year) ?? null;

  return (
    <SiteShell events={allEvents}>
      <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8 lg:py-10">
        <div className="flex flex-col gap-5 border-b border-slate-200 pb-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <TeamAvatar team={team} />
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">
                Team
              </p>
              <h1 className="mt-1 text-4xl font-black tracking-tight text-slate-950">
                {team.team_number}
              </h1>
              <p className="mt-1 text-lg font-semibold text-slate-700">
                {team.nickname || team.name || "Team"}
              </p>
              <p className="mt-2 text-sm text-slate-500">
                {team.city}
                {team.state_prov ? `, ${team.state_prov}` : ""}
                {team.country ? `, ${team.country}` : ""}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            {team.rookie_year != null && (
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-600">
                Rookie {team.rookie_year}
              </span>
            )}
            {team.website && (
              <a
                href={team.website}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 font-semibold text-blue-600 hover:border-blue-200 hover:bg-blue-50"
              >
                Team website
              </a>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-black tracking-tight text-slate-950">
            {year} Season
          </h2>
          <TeamSeasonSelector
            teamKey={teamKey}
            years={years}
            selectedYear={year}
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <Summary label="Events" value={sortedEvents.length} />
          <Summary label="Matches" value={completedMatches.length} />
          <Summary label="Record" value={`${wins}-${losses}-${ties}`} />
          <Summary
            label="District"
            value={district?.abbreviation || district?.display_name || "None"}
          />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-w-0">
            <SectionTitle title={`${year} Events`} />
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
              {sortedEvents.length === 0 ? (
                <p className="p-5 text-sm text-slate-500">
                  No events found for {year}.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {eventMatches.map(({ event, matches: eventTeamMatches }) => (
                    <div key={event.key} className="p-4">
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <Link
                          href={`/event/${event.key}`}
                          className="font-bold text-slate-900 hover:text-blue-600"
                        >
                          {event.name}
                        </Link>
                        <span className="text-xs text-slate-400">
                          {event.start_date} – {event.end_date}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {event.city}
                        {event.state_prov ? `, ${event.state_prov}` : ""}
                      </p>
                      <p className="mt-2 text-xs text-slate-500">
                        {eventTeamMatches.length} match{eventTeamMatches.length === 1 ? "" : "es"}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <SectionTitle title="Match Results" className="mt-8" />
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
              {matches.length === 0 ? (
                <p className="p-5 text-sm text-slate-500">
                  No matches found for {year}.
                </p>
              ) : (
                <div>
                  {eventMatches.map(({ event, matches: eventTeamMatches }) => (
                    <TeamEventMatches
                      key={event.key}
                      event={event}
                      matches={eventTeamMatches}
                      teamKey={teamKey}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-6">
            <section>
              <SectionTitle title="Team Information" />
              <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 text-sm">
                <Info label="Team number" value={String(team.team_number)} />
                <Info label="Nickname" value={team.nickname || "—"} />
                <Info label="Rookie year" value={team.rookie_year == null ? "—" : String(team.rookie_year)} />
                <Info label="Location" value={[team.city, team.state_prov, team.country].filter(Boolean).join(", ") || "—"} />
                <Info label="District" value={district?.display_name || district?.abbreviation || "None"} />
              </div>
            </section>
          </aside>
        </div>
      </div>
    </SiteShell>
  );
}

function Summary({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">
        {label}
      </p>
      <p className="mt-1 truncate text-2xl font-black text-slate-950">{value}</p>
    </div>
  );
}

function SectionTitle({ title, className = "" }: { title: string; className?: string }) {
  return (
    <h2 className={`text-lg font-black tracking-tight text-slate-950 ${className}`}>
      {title}
    </h2>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-2 last:border-b-0">
      <span className="text-slate-400">{label}</span>
      <span className="text-right font-semibold text-slate-700">{value}</span>
    </div>
  );
}
