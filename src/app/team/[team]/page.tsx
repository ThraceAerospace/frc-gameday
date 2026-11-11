import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import TeamAvatar from "@/components/team/TeamAvatar";
import TeamEventMatches from "@/components/team/TeamEventMatches";
import TeamEventsSidebar from "@/components/team/TeamEventsSidebar";
import TeamSeasonSelector from "@/components/team/TeamSeasonSelector";
import TeamRecord from "@/components/team/Record";
import PageContainer from "@/components/ui/PageContainer";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import SurfaceCard from "@/components/ui/SurfaceCard";
import { TBA } from "@/lib/tba/service";
import { formatPlayoffLevel } from "@/lib/tba/formatters";
import { formatEventDateRange } from "@/lib/time";
import type {
  TBAAward,
  TBAEventAdvancementPoints,
  TBAEvent,
  TBAEventSimple,
  TBAMatch,
  TBATeamEventStatus,
  TBAEventRanking,
} from "@/lib/tba/types";

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
  status: TBATeamEventStatus | null;
  awards: TBAAward[];
  advancementPoints: TBAEventAdvancementPoints | null;
  rankings: TBAEventRanking | null;
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
  const [teamEventsResponse, avatar] = await Promise.all([
    TBA.getTeamEvents(teamKey, year),
    TBA.getTeamAvatar(teamKey, year),
  ]);
  const teamEvents = [...teamEventsResponse].sort(sortEvents);

  const eventSections: TeamEventSection[] = await Promise.all(
    teamEvents.map(async (teamEvent) => {
      // Reuse the canonical full event response, which is shared with event pages.
      const [event, teamMatches, status, awards, advancementPoints, rankings] = await Promise.all([
        TBA.getEvent(teamEvent.key),
        TBA.getTeamMatches(teamKey, teamEvent.key),
        TBA.getTeamEventStatus(teamKey, teamEvent.key),
        TBA.getTeamEventAwards(teamKey, teamEvent.key),
        TBA.getEventAdvancementPoints(teamEvent.key),
        TBA.getEventRankings(teamEvent.key),
      ]);
      const matches = [...teamMatches].sort(sortMatches);
      const hasEliminationMatches = matches.some((match) =>
        ["ef", "qf", "sf", "f"].includes(match.comp_level.toLowerCase()),
      );
      const playoffAlliances = hasEliminationMatches || status?.alliance
        ? await TBA.getEventPlayoffAlliances(teamEvent.key)
        : null;
      return { event, matches, playoffAlliances, status, awards, advancementPoints, rankings };
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
      <PageContainer className="max-w-7xl">
        <PageHeader
          eyebrow="Team profile"
          leading={<TeamAvatar team={team} avatar={avatar} size="lg" />}
          title={<><span className="font-mono">{team.team_number}</span><span className="text-lg font-semibold text-[var(--fv-muted)] sm:text-xl">{team.nickname || team.name || "Team"}</span></>}
          description={[team.city, team.state_prov, team.country].filter(Boolean).join(", ")}
          actions={<TeamSeasonSelector years={years} selectedYear={year} />}
          footer={<>{team.rookie_year != null ? <span>Rookie {team.rookie_year}</span> : null}{team.website ? <a href={team.website} target="_blank" rel="noreferrer" className="font-semibold text-[var(--fv-brand)] hover:text-[var(--fv-brand-strong)]">Team website</a> : null}</>}
        />
        <SurfaceCard className="mt-5" padding>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div><span className="font-black text-[var(--fv-text)]">{year}</span><span className="ml-1.5 text-[var(--fv-muted)]">season</span></div>
            <Stat label="District" value={district?.display_name || "None"} />
            <Stat label="Events" value={eventSections.length} />
            <Stat label="Matches" value={completedMatches.length} />
            <Stat label="Record" value={`${wins}-${losses}-${ties}`} />
          </div>
        </SurfaceCard>
        <div className="mt-8">
          <SectionHeading title={`${year} Results`} description="Event information and match results for this season." action={district ? <Link href={`/district/${district.key}`} className="text-sm font-semibold text-[var(--fv-brand)] hover:text-[var(--fv-brand-strong)]">View district</Link> : null} className="mb-5" />

          {eventSections.length === 0 ? (
            <SurfaceCard className="p-5 text-sm text-[var(--fv-muted)]">No events found for {year}.</SurfaceCard>
          ) : (
            <div className="grid items-start gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
              <TeamEventsSidebar events={eventSections.map(({ event }) => ({ id: `event-section-${event.key}`, key: event.key, name: event.short_name ?? event.name }))} />
              <div className="min-w-0 space-y-5">
                {eventSections.map(({ event, matches, playoffAlliances, status, awards, advancementPoints, rankings }) => {
                  const teamAlliance = playoffAlliances?.find((alliance) =>
                    alliance.picks.includes(teamKey),
                  );
                  const allianceStatus = teamAlliance?.status;
                  const allianceRecord = event.playoff_type === 10 || event.playoff_type === 11
                    ? allianceStatus?.record
                    : allianceStatus?.current_level_record;
                  const ranking = status?.qual?.ranking;
                  const eventRanking = rankings?.rankings.find((entry) => entry.team_key === teamKey);
                  const rankingPointsIndex = rankings?.extra_stats_info.findIndex((extraStat) =>
                    /total ranking points/i.test(extraStat.name),
                  ) ?? -1;
                  const totalRankingPoints = rankingPointsIndex >= 0
                    ? eventRanking?.extra_stats[rankingPointsIndex]
                    : undefined;
                  const rankingPointsPrecision = rankingPointsIndex >= 0
                    ? rankings?.extra_stats_info[rankingPointsIndex]?.precision
                    : undefined;
                  const eventPoints = advancementPoints?.points[teamKey];
                  const allianceName = teamAlliance?.name
                    || status?.alliance?.name
                    || (status?.alliance ? `Alliance ${status.alliance.number}` : "—");

                  return (
                    <SurfaceCard key={event.key} id={`event-section-${event.key}`} className="scroll-mt-5 overflow-hidden">
                      <div className="grid min-w-0 xl:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.7fr)]">
                        <div className="border-b border-[var(--fv-border)] bg-[var(--fv-surface)] p-4 xl:border-b-0 xl:border-r">
                          <h3 className="mt-1 text-lg font-bold leading-snug text-[var(--fv-text)]">{event.name}</h3>
                          <p className="mt-2 text-sm text-[var(--fv-muted)]">{event.city}{event.state_prov ? `, ${event.state_prov}` : ""}{event.country ? `, ${event.country}` : ""}</p>
                          <p className="mt-1 text-xs text-[var(--fv-muted)]">{formatEventDateRange(event.start_date, event.end_date)}</p>
                          {event.week != null && <p className="mt-1 text-xs font-medium text-[var(--fv-muted)]">Week {event.week + 1}</p>}
                          {event.district?.display_name && <p className="mt-2 text-xs font-medium text-[var(--fv-muted)]">{event.district.display_name}</p>}
                          <div className="mt-4 flex flex-wrap gap-2">
                            <Link href={`/event/${event.key}`} className="rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-3 py-2 text-xs font-semibold text-[var(--fv-text)] hover:border-[var(--fv-brand-border)] hover:text-[var(--fv-brand-strong)]">Event page</Link>
                            <Link href={`/gameday?event=${event.key}`} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--fv-brand-strong)]">Gameday</Link>
                          </div>
                          <div className="mt-4 space-y-3 border-t border-[var(--fv-border)] pt-3">
                            <section className="rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-3">
                              <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--fv-muted)]">Qualification</h4>
                              <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
                                <div>
                                  <dt className="text-xs text-[var(--fv-muted)]">Record</dt>
                                  <dd className="font-semibold text-[var(--fv-text)]"><TeamRecord status={status} /></dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-[var(--fv-muted)]">Rank</dt>
                                  <dd className="font-semibold text-[var(--fv-text)]">
                                    {ranking?.rank != null
                                      ? `#${ranking.rank}${status?.qual?.num_teams != null ? ` of ${status.qual.num_teams}` : ""}`
                                      : "—"}
                                  </dd>
                                </div>
                                {totalRankingPoints != null && (
                                  <div>
                                    <dt className="text-xs text-[var(--fv-muted)]">Total Ranking Points</dt>
                                    <dd className="font-semibold tabular-nums text-[var(--fv-text)]">
                                      {totalRankingPoints.toFixed(rankingPointsPrecision ?? 0)}
                                    </dd>
                                  </div>
                                )}
                              </dl>
                            </section>
                            <section className="rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-3">
                              <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--fv-muted)]">Alliance</h4>
                              <p className="mt-2 text-sm font-semibold text-[var(--fv-text)]">{allianceName}</p>
                              {teamAlliance?.picks.length ? (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {teamAlliance.picks.map((memberKey) => (
                                    <Link
                                      key={memberKey}
                                      href={`/team/${memberKey}?year=${year}`}
                                      aria-current={memberKey === teamKey ? "page" : undefined}
                                      className={`rounded-full border px-2 py-0.5 font-mono text-xs ${memberKey === teamKey ? "border-slate-400 bg-slate-200 font-bold text-[var(--fv-text)]" : "border-[var(--fv-border)] bg-[var(--fv-surface-raised)] font-medium text-[var(--fv-text)] hover:border-slate-400 hover:bg-[var(--fv-surface)]"}`}
                                    >
                                      {memberKey.replace(/^frc/i, "")}
                                    </Link>
                                  ))}
                                </div>
                              ) : null}
                            </section>
                            <section className="rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-3">
                              <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--fv-muted)]">Eliminations</h4>
                              <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
                                <div>
                                  <dt className="text-xs text-[var(--fv-muted)]">Record</dt>
                                  <dd className="font-semibold text-[var(--fv-text)]">
                                    {teamAlliance?.status && allianceRecord
                                      ? `${allianceRecord.wins ?? 0}-${allianceRecord.losses ?? 0}-${allianceRecord.ties ?? 0}`
                                      : "—"}
                                  </dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-[var(--fv-muted)]">Level</dt>
                                  <dd className="font-semibold text-[var(--fv-text)]">
                                    {teamAlliance?.status ? formatPlayoffLevel(teamAlliance, event.playoff_type) : "—"}
                                  </dd>
                                </div>
                              </dl>
                            </section>
                          </div>
                          {(ranking?.matches_played != null || ranking?.qual_average != null || (ranking?.dq != null && ranking.dq > 0)) && (
                            <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-[var(--fv-border)] pt-3 text-sm">
                              {ranking?.matches_played != null && (
                                <div><dt className="text-xs text-[var(--fv-muted)]">Matches played</dt><dd className="font-semibold text-[var(--fv-text)]">{ranking.matches_played}</dd></div>
                              )}
                              {ranking?.qual_average != null && (
                                <div><dt className="text-xs text-[var(--fv-muted)]">Qualification average</dt><dd className="font-semibold text-[var(--fv-text)]">{ranking.qual_average}</dd></div>
                              )}
                              {ranking?.dq != null && ranking.dq > 0 && (
                                <div><dt className="text-xs text-[var(--fv-muted)]">Disqualifications</dt><dd className="font-semibold text-[var(--fv-text)]">{ranking.dq}</dd></div>
                              )}
                            </dl>
                          )}
                          {eventPoints && (
                            <div className="mt-3 border-t border-[var(--fv-border)] pt-3">
                              <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--fv-muted)]">Advancement Points</h4>
                              <table className="mt-2 w-full text-xs text-[var(--fv-text)]">
                                <tbody>
                                  <tr><th scope="row" className="py-0.5 text-left font-normal">Qualification</th><td className="py-0.5 text-right font-mono">{eventPoints.qual_points}</td></tr>
                                  <tr><th scope="row" className="py-0.5 text-left font-normal">Alliance selection</th><td className="py-0.5 text-right font-mono">{eventPoints.alliance_points}</td></tr>
                                  <tr><th scope="row" className="py-0.5 text-left font-normal">Elimination matches</th><td className="py-0.5 text-right font-mono">{eventPoints.elim_points}</td></tr>
                                  <tr><th scope="row" className="py-0.5 text-left font-normal">Awards</th><td className="py-0.5 text-right font-mono">{eventPoints.award_points}</td></tr>
                                  <tr className="border-t border-[var(--fv-border)] font-semibold"><th scope="row" className="pt-1 text-left">Total</th><td className="pt-1 text-right font-mono">{eventPoints.total}</td></tr>
                                </tbody>
                              </table>
                            </div>
                          )}
                          {awards.length > 0 && (
                            <div className="mt-3 border-t border-[var(--fv-border)] pt-3 text-sm">
                              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--fv-muted)]">Awards</span>
                              <p className="mt-1 text-[var(--fv-text)]">{awards.map((award) => award.name).join(", ")}</p>
                            </div>
                          )}
                        </div>
                        <TeamEventMatches event={event} matches={matches} highlightedTeamKeys={[teamKey]} playoffAlliances={playoffAlliances} />
                      </div>
                    </SurfaceCard>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </PageContainer>
    </SiteShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div><span className="text-[var(--fv-muted)]">{label}</span><span className="ml-1.5 font-bold text-[var(--fv-text)]">{value}</span></div>;
}
