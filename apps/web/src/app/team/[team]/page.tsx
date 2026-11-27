import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import TeamAvatar from "@/components/team/TeamAvatar";
import TeamEventMatches from "@/components/team/TeamEventMatches";
import TeamProfileTabs from "@/components/team/TeamProfileTabs";
import TeamEventsSidebar from "@/components/team/TeamEventsSidebar";
import TeamSeasonSelector from "@/components/team/TeamSeasonSelector";
import TeamRecord from "@/components/team/Record";
import PageContainer from "@/components/ui/PageContainer";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import SurfaceCard from "@/components/ui/SurfaceCard";
import { notFound } from "next/navigation";
import { getCanonicalCurrentSeason, getCanonicalEventSnapshot, getCanonicalTeamDiscovery, getCanonicalTeamSnapshot } from "@/lib/events/serverSnapshot";
import type {
  FieldViewEventSnapshot,
  FieldViewTeam,
  FieldViewTeamSnapshot,
} from "@fieldview/domain";
import { formatPlayoffLevel } from "@/lib/tba/formatters";
import { formatEventDateRange } from "@/lib/time";


function normalizeTeamKey(value: string): string {
  return value.startsWith("frc") ? value : `frc${value}`;
}

type TeamData = NonNullable<FieldViewTeamSnapshot["team"]>;
type TeamEventReference = NonNullable<FieldViewTeamSnapshot["events"]>[number];
type TeamDistrict = NonNullable<FieldViewTeamSnapshot["districts"]>[number];
type TeamAvatarData = Extract<NonNullable<FieldViewTeamSnapshot["media"]>[number], { type: "avatar" }>;
type CanonicalEvent = NonNullable<FieldViewEventSnapshot["event"]>;
type CanonicalMatch = NonNullable<NonNullable<FieldViewEventSnapshot["matches"]>[number]>;
type CanonicalStatus = NonNullable<NonNullable<FieldViewEventSnapshot["event_teams"]>[number]["tba_status"]>;

function sortEvents(a: TeamEventReference, b: TeamEventReference) {
  return a.start_date.localeCompare(b.start_date) ||
    a.name.localeCompare(b.name) ||
    a.key.localeCompare(b.key, undefined, { numeric: true });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function getTeamResult(match: CanonicalMatch, teamKey: string) {
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
  event: CanonicalEvent;
  matches: NonNullable<FieldViewEventSnapshot["matches"]> | null;
  playoffAlliances: NonNullable<FieldViewEventSnapshot["playoff_alliances"]> | null;
  status: CanonicalStatus | null;
  awards: NonNullable<FieldViewEventSnapshot["awards"]> | null;
  advancementPoints: NonNullable<FieldViewEventSnapshot["advancement_points"]> | null;
  rankings: NonNullable<FieldViewEventSnapshot["rankings"]> | null;
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
  const currentSeason = await getCanonicalCurrentSeason();
  if (!currentSeason) {
    return (
      <SiteShell>
        <PageContainer>
          <PageHeader eyebrow="Team profile" title={teamKey.replace(/^frc/i, "")} description="The TBA current season is not available yet. Refresh FieldView season discovery and reload this page." />
        </PageContainer>
      </SiteShell>
    );
  }
  const currentYear = currentSeason.year;

  const initialCanonical = await getCanonicalTeamSnapshot(teamKey, currentYear);
  const teamSource = initialCanonical?.snapshot.sources.tba_team;
  if (teamSource && initialCanonical?.snapshot.team === null) notFound();
  const discoveredTeams = !initialCanonical?.snapshot.team
    ? await getCanonicalTeamDiscovery(currentYear)
    : null;
  const discoveredTeam = discoveredTeams?.find((candidate) => candidate.key === teamKey) ?? null;
  const team: TeamData | null = initialCanonical?.snapshot.team ?? (discoveredTeam as TeamData | null);
  if (!team) {
    console.info("[FV][IncompleteStateServed]", JSON.stringify({ entity_kind: "team", entity_key: teamKey, reason: "team_and_snapshot_unavailable", year: currentYear }));
    notFound();
  }

  const years = Array.from(
    { length: currentYear - (team?.rookie_year ?? currentYear) + 1 },
    (_, index) => currentYear - index,
  );
  const requestedYear = Number(Array.isArray(search.year) ? search.year[0] : search.year);
  const year = years.includes(requestedYear) ? requestedYear : currentYear;
  const canonicalTeam = year === currentYear
    ? initialCanonical
    : await getCanonicalTeamSnapshot(teamKey, year);

  const districts: TeamDistrict[] | null = canonicalTeam?.snapshot.districts ?? null;
  const teamEventsResponse: TeamEventReference[] | null = canonicalTeam?.snapshot.events ?? null;
  const avatar = (canonicalTeam?.snapshot.media ?? []).find(
    (item): item is TeamAvatarData => item.type === "avatar",
  ) ?? null;
  const teamEvents = teamEventsResponse === null ? [] : [...teamEventsResponse].sort(sortEvents);
  const hasCanonicalTeamState = canonicalTeam?.snapshot.team != null;

  // Team/event pages consume only canonical snapshots. An unacquired or
  // unavailable event section remains unavailable instead of issuing a
  // second provider-shaped request from the page.
  const eventSections: TeamEventSection[] = hasCanonicalTeamState ? (await mapWithConcurrency(
    teamEvents,
    4,
    async (teamEvent): Promise<TeamEventSection | null> => {
      const canonical = await getCanonicalEventSnapshot(teamEvent.key);
      const snapshot = canonical?.snapshot;
      const event = snapshot?.event;
      if (!snapshot || !event) return null;

      const eventTeams = snapshot.event_teams;
      const status = eventTeams?.find((entry) => entry.team_key === teamKey)?.tba_status ?? null;
      const matches = snapshot.matches === undefined || snapshot.matches === null
        ? null
        : snapshot.matches.filter((match) =>
            match.alliances?.red?.team_keys?.includes(teamKey) ||
            match.alliances?.blue?.team_keys?.includes(teamKey),
          );
      const awards = snapshot.awards === undefined || snapshot.awards === null
        ? null
        : snapshot.awards.filter((award) =>
            award.recipient_list.some((recipient) => recipient.team_key === teamKey),
          );
      return {
        event,
        matches,
        playoffAlliances: snapshot.playoff_alliances ?? null,
        status,
        awards,
        advancementPoints: snapshot.advancement_points ?? null,
        rankings: snapshot.rankings ?? null,
      };
    },
  )).filter((section): section is TeamEventSection => section !== null) : [];

  const matchDataComplete = eventSections.length === teamEvents.length &&
    eventSections.every(({ matches }) => matches !== null);
  const incompleteReasons = [
    !hasCanonicalTeamState ? "team_state_missing" : null,
    teamEventsResponse === null ? "team_events_missing" : null,
    eventSections.length < teamEvents.length ? "team_event_snapshots_missing" : null,
    !matchDataComplete ? "team_match_data_incomplete" : null,
  ].filter((reason): reason is string => reason !== null);
  if (incompleteReasons.length > 0) console.info("[FV][IncompleteStateServed]", JSON.stringify({ entity_kind: "team", entity_key: teamKey, reasons: incompleteReasons, year }));
  const completedMatches = eventSections.flatMap(({ event, matches }) =>
    (matches ?? [])
      .filter((match) => (match.alliances?.red?.score ?? -1) >= 0 && (match.alliances?.blue?.score ?? -1) >= 0)
      .map((match) => ({ event, match })),
  );
  const wins = completedMatches.filter(({ match }) => getTeamResult(match, teamKey) === "Win").length;
  const losses = completedMatches.filter(({ match }) => getTeamResult(match, teamKey) === "Loss").length;
  const ties = completedMatches.filter(({ match }) => getTeamResult(match, teamKey) === "Tie").length;

  return (
    <SiteShell>
      <PageContainer className="max-w-7xl">
        {!hasCanonicalTeamState ? <div className="mb-4 rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-card)] px-4 py-3 text-sm text-[var(--fv-muted)]" role="status">FieldView team and season data is incomplete. Showing the available team profile from The Blue Alliance; event results, rankings, and match analytics may be unavailable.</div> : incompleteReasons.length > 0 ? <div className="mb-4 rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-card)] px-4 py-3 text-sm text-[var(--fv-muted)]" role="status">Some FieldView team data is unavailable. The information shown below may be incomplete.</div> : null}
        <PageHeader
          eyebrow="Team profile"
          leading={team ? <TeamAvatar team={team} avatar={avatar} size="lg" /> : undefined}
          title={<><span className="font-mono">{team?.team_number ?? teamKey.replace(/^frc/i, "")}</span><span className="text-lg font-semibold text-[var(--fv-muted)] sm:text-xl">{team?.nickname || team?.name || "Team"}</span></>}
          description={team ? [team.city, team.state_prov, team.country].filter(Boolean).join(", ") : "Team details are loading from the canonical runtime."}
          actions={<TeamSeasonSelector years={years} selectedYear={year} />}
          footer={<>{team?.rookie_year != null ? <span>Rookie {team.rookie_year}</span> : null}{team?.website ? <a href={team.website} target="_blank" rel="noreferrer" className="font-semibold text-[var(--fv-brand)] hover:text-[var(--fv-brand-strong)]">Team website</a> : null}</>}
        />
        <SurfaceCard className="mt-5" padding>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div><span className="font-black text-[var(--fv-text)]">{year}</span><span className="ml-1.5 text-[var(--fv-muted)]">season</span></div>
            <Stat label="District" value={districts === null ? "Unavailable" : districts[0]?.display_name || "None"} />
            <Stat label="Events" value={teamEventsResponse === null ? "Unavailable" : teamEvents.length} />
            <Stat label="Matches" value={matchDataComplete ? completedMatches.length : "—"} />
            <Stat label="Record" value={matchDataComplete ? `${wins}-${losses}-${ties}` : "Unavailable"} />
          </div>
        </SurfaceCard>
        <TeamProfileTabs teamNumber={team?.team_number ?? Number(teamKey.replace(/^frc/i, ""))} year={year} results={
          <div>
          <SectionHeading title={`${year} Results`} description="Event information and match results for this season." className="mb-5" />

          {eventSections.length === 0 ? (
            <SurfaceCard className="p-5 text-sm text-[var(--fv-muted)]">{teamEventsResponse === null ? `Season event data is unavailable for ${year}.` : teamEvents.length > 0 ? `Event details are still being acquired for ${year}.` : `No events found for ${year}.`}</SurfaceCard>
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
                          {awards === null ? (
                            <div className="mt-3 border-t border-[var(--fv-border)] pt-3 text-xs text-[var(--fv-muted)]">Award data is unavailable.</div>
                          ) : awards.length > 0 ? (
                            <div className="mt-3 border-t border-[var(--fv-border)] pt-3 text-sm">
                              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--fv-muted)]">Awards</span>
                              <p className="mt-1 text-[var(--fv-text)]">{awards.map((award) => award.name).join(", ")}</p>
                            </div>
                          ) : null}
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
        } />
      </PageContainer>
    </SiteShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div><span className="text-[var(--fv-muted)]">{label}</span><span className="ml-1.5 font-bold text-[var(--fv-text)]">{value}</span></div>;
}
