import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import TeamAvatar from "@/components/team/TeamAvatar";
import TeamEventMatches from "@/components/team/TeamEventMatches";
import TeamEventsSidebar from "@/components/team/TeamEventsSidebar";
import TeamSeasonSelector from "@/components/team/TeamSeasonSelector";
import { TBA } from "@/lib/tba/service";
import type { TBAEvent, TBAEventSimple, TBAMatch } from "@/lib/tba/types";

function normalizeTeamKey(value: string): string {
  return value.startsWith("frc") ? value : `frc${value}`;
}

function sortEvents(a: TBAEventSimple, b: TBAEventSimple) {
  return a.start_date.localeCompare(b.start_date) ||
    a.name.localeCompare(b.name) ||
    a.key.localeCompare(b.key, undefined, { numeric: true });
}

function sortMatches(a: TBAMatch, b: TBAMatch) {
  return (a.time ?? a.actual_time ?? Infinity) - (b.time ?? b.actual_time ?? Infinity) ||
    (a.comp_level === "qm" ? 0 : 1) - (b.comp_level === "qm" ? 0 : 1) ||
    (a.set_number ?? 0) - (b.set_number ?? 0) ||
    (a.match_number ?? 0) - (b.match_number ?? 0);
}

function getTeamResult(match: TBAMatch, teamKey: string) {
  const red = match.alliances?.red;
  const blue = match.alliances?.blue;
  const isRed = red?.team_keys?.includes(teamKey) ?? false;
  const alliance = isRed ? red : blue;
  const opponent = isRed ? blue : red;
  if (!alliance || !opponent || alliance.score < 0 || opponent.score < 0) return "Upcoming";
  if (alliance.score > opponent.score) return "Win";
  if (alliance.score < opponent.score) return "Loss";
  return "Tie";
}

type TeamEventSection = {
  event: TBAEvent;
  matches: TBAMatch[];
  playoffAlliances: Awaited<ReturnType<typeof TBA.getEventPlayoffAlliances>>;
};

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

  const [team, districts] = await Promise.all([
    TBA.getTeam(teamKey),
    TBA.getTeamDistricts(teamKey),
  ]);

  const years = Array.from(
    { length: currentYear - (team.rookie_year ?? currentYear) + 1 },
    (_, index) => currentYear - index,
  );
  const requestedYear = Number(Array.isArray(search.year) ? search.year[0] : search.year);
  const year = years.includes(requestedYear) ? requestedYear : currentYear;
  const teamEvents = [...(await TBA.getTeamEvents(teamKey, year))].sort(sortEvents);

  const eventSections: TeamEventSection[] = await Promise.all(
    teamEvents.map(async (teamEvent) => {
      // Reuse the canonical full event response, which is shared with event pages.
      const [event, teamMatches] = await Promise.all([
        TBA.getEvent(teamEvent.key),
        TBA.getTeamMatches(teamKey, teamEvent.key),
      ]);
      const matches = [...teamMatches].sort(sortMatches);
      const hasEliminationMatches = matches.some((match) =>
        ["ef", "qf", "sf", "f"].includes(match.comp_level.toLowerCase()),
      );
      const playoffAlliances = hasEliminationMatches
        ? await TBA.getEventPlayoffAlliances(teamEvent.key)
        : null;
      return { event, matches, playoffAlliances };
    }),
  );

  const completedMatches = eventSections.flatMap(({ event, matches }) =>
    matches
      .filter((match) => (match.alliances?.red?.score ?? -1) >= 0 && (match.alliances?.blue?.score ?? -1) >= 0)
      .map((match) => ({ event, match })),
  );
  const wins = completedMatches.filter(({ match }) => getTeamResult(match, teamKey) === "Win").length;
  const losses = completedMatches.filter(({ match }) => getTeamResult(match, teamKey) === "Loss").length;
  const ties = completedMatches.filter(({ match }) => getTeamResult(match, teamKey) === "Tie").length;
  const district = districts.find((entry) => entry.year === year) ?? null;

  return (
    <SiteShell>
      <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8 lg:py-10">
        <header className="flex flex-col gap-5 border-b border-slate-200 pb-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <TeamAvatar team={team} size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="text-4xl font-black tracking-tight text-slate-950">{team.team_number}</h1>
                <p className="text-xl font-semibold text-slate-700">{team.nickname || team.name || "Team"}</p>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {team.city}{team.state_prov ? `, ${team.state_prov}` : ""}{team.country ? `, ${team.country}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                {team.rookie_year != null && <span>Rookie {team.rookie_year}</span>}
                {team.website && <><span aria-hidden="true">·</span><a href={team.website} target="_blank" rel="noreferrer" className="font-semibold text-blue-600 hover:text-blue-700">Team website</a></>}
              </div>
            </div>
          </div>
          <TeamSeasonSelector years={years} selectedYear={year} />
        </header>

        <section className="mt-5 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div><span className="font-black text-slate-950">{year}</span><span className="ml-1.5 text-slate-500">season</span></div>
            <Stat label="District" value={district?.abbreviation || district?.display_name || "None"} />
            <Stat label="Events" value={eventSections.length} />
            <Stat label="Matches" value={completedMatches.length} />
            <Stat label="Record" value={`${wins}-${losses}-${ties}`} />
          </div>
        </section>

        <div className="mt-8">
          <div className="mb-5 flex items-baseline justify-between gap-4">
            <div>
              <h2 className="text-xl font-black tracking-tight text-slate-950">{year} Results</h2>
              <p className="mt-1 text-sm text-slate-500">Event information and match results for this season.</p>
            </div>
            {district && <Link href={`/district/${district.key}`} className="hidden text-sm font-semibold text-blue-600 hover:text-blue-700 sm:block">View district</Link>}
          </div>

          {eventSections.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">No events found for {year}.</p>
          ) : (
            <div className="grid items-start gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
              <TeamEventsSidebar events={eventSections.map(({ event }) => ({ id: `event-section-${event.key}`, key: event.key, name: event.name }))} />
              <div className="min-w-0 space-y-5">
                {eventSections.map(({ event, matches, playoffAlliances }) => (
                  <section key={event.key} id={`event-section-${event.key}`} className="scroll-mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="grid min-w-0 xl:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.7fr)]">
                      <div className="border-b border-slate-200 bg-slate-50 p-4 xl:border-b-0 xl:border-r">
                        <p className="font-mono text-xs text-slate-400">{event.key}</p>
                        <h3 className="mt-1 text-lg font-bold leading-snug text-slate-900">{event.name}</h3>
                        <p className="mt-2 text-sm text-slate-600">{event.city}{event.state_prov ? `, ${event.state_prov}` : ""}{event.country ? `, ${event.country}` : ""}</p>
                        <p className="mt-1 text-xs text-slate-500">{event.start_date} – {event.end_date}</p>
                        {event.timezone && <p className="mt-1 text-xs text-slate-400">{event.timezone}</p>}
                        {event.district?.display_name && <p className="mt-2 text-xs font-medium text-slate-500">{event.district.display_name}</p>}
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Link href={`/event/${event.key}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-blue-200 hover:text-blue-700">Event page</Link>
                          <Link href={`/gameday?event=${event.key}`} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700">Gameday</Link>
                        </div>
                      </div>
                      <TeamEventMatches event={event} matches={matches} highlightedTeamKeys={[teamKey]} playoffAlliances={playoffAlliances} />
                    </div>
                  </section>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </SiteShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div><span className="text-slate-400">{label}</span><span className="ml-1.5 font-bold text-slate-700">{value}</span></div>;
}
