import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import { TBA } from "@/lib/tba/service";
import type { TBAMatch, TBAEventSimple } from "@/lib/tba/types";

function normalizeTeamKey(value: string): string {
  return value.startsWith("frc") ? value : `frc${value}`;
}

function formatMatchName(match: TBAMatch): string {
  const level = match.comp_level;
  const set = match.set_number ?? 0;
  const number = match.match_number ?? 0;

  if (level === "qm") return `Qualification ${number}`;
  if (level === "ef") return `Eighthfinal ${set}-${number}`;
  if (level === "qf") return `Quarterfinal ${set}-${number}`;
  if (level === "sf") return `Semifinal ${set}-${number}`;
  if (level === "f") return `Final ${number}`;
  return match.key;
}

function getTeamResult(match: TBAMatch, teamKey: string) {
  const red = match.alliances?.red;
  const blue = match.alliances?.blue;
  const isRed = red?.team_keys?.includes(teamKey) ?? false;
  const alliance = isRed ? red : blue;
  const opponent = isRed ? blue : red;

  if (!alliance || !opponent || alliance.score < 0 || opponent.score < 0) {
    return { alliance: isRed ? "Red" : "Blue", result: "Upcoming", score: null, opponentScore: null };
  }

  if (alliance.score > opponent.score) {
    return { alliance: isRed ? "Red" : "Blue", result: "Win", score: alliance.score, opponentScore: opponent.score };
  }

  if (alliance.score < opponent.score) {
    return { alliance: isRed ? "Red" : "Blue", result: "Loss", score: alliance.score, opponentScore: opponent.score };
  }

  return { alliance: isRed ? "Red" : "Blue", result: "Tie", score: alliance.score, opponentScore: opponent.score };
}

function sortEvents(a: TBAEventSimple, b: TBAEventSimple) {
  return (
    a.start_date.localeCompare(b.start_date) ||
    a.name.localeCompare(b.name) ||
    a.key.localeCompare(b.key, undefined, { numeric: true })
  );
}

export default async function TeamPage({
  params,
}: {
  params: Promise<{ team: string }>;
}) {
  const { team: rawTeam } = await params;
  const teamKey = normalizeTeamKey(rawTeam);
  const year = new Date().getFullYear();

  const [team, events, districts] = await Promise.all([
    TBA.getTeam(teamKey),
    TBA.getTeamEvents(teamKey, year),
    TBA.getTeamDistricts(teamKey),
  ]);

  const sortedEvents = [...events].sort(sortEvents);
  const eventMatches = await Promise.all(
    sortedEvents.map(async (event) => ({
      event,
      matches: await TBA.getTeamMatches(teamKey, event.key),
    }))
  );

  const matches = eventMatches
    .flatMap(({ event, matches }) =>
      matches.map((match) => ({ event, match }))
    )
    .sort(
      (a, b) =>
        (b.match.actual_time ?? b.match.time ?? 0) -
          (a.match.actual_time ?? a.match.time ?? 0) ||
        b.event.start_date.localeCompare(a.event.start_date)
    );

  const completedMatches = matches.filter(({ match }) => {
    const red = match.alliances?.red?.score ?? -1;
    const blue = match.alliances?.blue?.score ?? -1;
    return red >= 0 && blue >= 0;
  });

  const wins = completedMatches.filter(
    ({ match }) => getTeamResult(match, teamKey).result === "Win"
  ).length;
  const losses = completedMatches.filter(
    ({ match }) => getTeamResult(match, teamKey).result === "Loss"
  ).length;
  const ties = completedMatches.filter(
    ({ match }) => getTeamResult(match, teamKey).result === "Tie"
  ).length;

  return (
    <SiteShell events={await TBA.getEvents(year)}>
      <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8 lg:py-10">
        <div className="flex flex-col gap-5 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
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

          <div className="flex flex-wrap gap-2 text-sm">
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

        <div className="mt-6 grid gap-4 sm:grid-cols-4">
          <Summary label="Events" value={sortedEvents.length} />
          <Summary label="Matches" value={completedMatches.length} />
          <Summary label="Record" value={`${wins}-${losses}-${ties}`} />
          <Summary label="Districts" value={districts.length} />
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
                      {eventTeamMatches.length > 0 && (
                        <p className="mt-2 text-xs text-slate-500">
                          {eventTeamMatches.length} match{eventTeamMatches.length === 1 ? "" : "es"}
                        </p>
                      )}
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
                <div className="divide-y divide-slate-100">
                  {matches.map(({ event, match }) => {
                    const result = getTeamResult(match, teamKey);
                    return (
                      <div
                        key={match.key}
                        className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_140px_90px] sm:items-center"
                      >
                        <div className="min-w-0">
                          <Link
                            href={`/event/${event.key}/match/${match.key}`}
                            className="font-semibold text-slate-900 hover:text-blue-600"
                          >
                            {formatMatchName(match)}
                          </Link>
                          <p className="truncate text-xs text-slate-400">
                            {event.name}
                          </p>
                        </div>
                        <span className="text-xs font-semibold text-slate-500">
                          {result.alliance}
                        </span>
                        <span
                          className={
                            result.result === "Win"
                              ? "font-bold text-emerald-600"
                              : result.result === "Loss"
                                ? "font-bold text-red-600"
                                : result.result === "Tie"
                                  ? "font-bold text-amber-600"
                                  : "font-semibold text-slate-400"
                          }
                        >
                          {result.score != null
                            ? `${result.result} ${result.score}-${result.opponentScore}`
                            : result.result}
                        </span>
                      </div>
                    );
                  })}
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
              </div>
            </section>

            <section>
              <SectionTitle title="Districts" />
              <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
                {districts.length === 0 ? (
                  <p className="text-sm text-slate-500">No district history.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {districts.map((district) => (
                      <Link
                        key={district.key}
                        href={`/districts`}
                        className="rounded-full border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
                      >
                        {district.display_name || district.abbreviation || district.key}
                      </Link>
                    ))}
                  </div>
                )}
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
      <p className="mt-1 text-2xl font-black text-slate-950">{value}</p>
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
