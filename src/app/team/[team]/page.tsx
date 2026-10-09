import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import TeamAvatar from "@/components/team/TeamAvatar";
import TeamEventMatches from "@/components/team/TeamEventMatches";
import TeamSeasonSelector from "@/components/team/TeamSeasonSelector";
import { TBA } from "@/lib/tba/service";
import type { TBAEliminationAlliance, TBAEvent, TBAEventSimple, TBAMatch } from "@/lib/tba/types";

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
    (a.time ?? a.actual_time ?? Infinity) -
      (b.time ?? b.actual_time ?? Infinity) ||
    (a.comp_level === "qm" ? 0 : 1) -
      (b.comp_level === "qm" ? 0 : 1) ||
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
    sortedEvents.map(async (event) => {
      const [fullEvent, matches, playoffAlliances] = await Promise.all([
        TBA.getEvent(event.key),
        TBA.getTeamMatches(teamKey, event.key),
        TBA.getEventPlayoffAlliances(event.key),
      ]);

      return {
        event: { ...event, playoff_type: fullEvent.playoff_type },
        matches: matches.sort(sortMatches),
        playoffAlliances,
      };
    }),
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
        <header className="flex flex-col gap-5 border-b border-slate-200 pb-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <TeamAvatar team={team} size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="text-4xl font-black tracking-tight text-slate-950">
                  {team.team_number}
                </h1>
                <p className="text-xl font-semibold text-slate-700">
                  {team.nickname || team.name || "Team"}
                </p>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {team.city}
                {team.state_prov ? `, ${team.state_prov}` : ""}
                {team.country ? `, ${team.country}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                {team.rookie_year != null && <span>Rookie {team.rookie_year}</span>}
                {team.website && (
                  <>
                    <span aria-hidden="true">·</span>
                    <a
                      href={team.website}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-blue-600 hover:text-blue-700"
                    >
                      Team website
                    </a>
                  </>
                )}
              </div>
            </div>
          </div>

          <TeamSeasonSelector
            years={years}
            selectedYear={year}
          />
        </header>

        <section className="mt-5 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="font-black text-slate-950">{year}</span>
              <span className="ml-1.5 text-slate-500">season</span>
            </div>
            <Stat label="District" value={district?.abbreviation || district?.display_name || "None"} />
            <Stat label="Events" value={sortedEvents.length} />
            <Stat label="Matches" value={completedMatches.length} />
            <Stat label="Record" value={`${wins}-${losses}-${ties}`} />
          </div>
        </section>

        <main className="mt-8">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h2 className="text-xl font-black tracking-tight text-slate-950">
                {year} Results
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Events, matches, alliances, and results for this season.
              </p>
            </div>
            {district && (
              <Link
                href={`/district/${district.key}`}
                className="hidden text-sm font-semibold text-blue-600 hover:text-blue-700 sm:block"
              >
                View district
              </Link>
            )}
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {eventMatches.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">
                No events found for {year}.
              </p>
            ) : (
              eventMatches.map(({ event, matches: eventTeamMatches, playoffAlliances }) => (
                <TeamEventMatches
                  key={event.key}
                  event={event}
                  matches={eventTeamMatches}
                  highlightedTeamKeys={[teamKey]}
                  playoffAlliances={playoffAlliances}
                />
              ))
            )}
          </div>
        </main>
      </div>
    </SiteShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span className="text-slate-400">{label}</span>
      <span className="ml-1.5 font-bold text-slate-700">{value}</span>
    </div>
  );
}
