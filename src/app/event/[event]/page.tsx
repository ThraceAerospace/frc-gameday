import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import { TBA } from "@/lib/tba/service";
import type {
  TBAEliminationAlliance,
  TBAMatch,
  TBAMatchSimple,
  TBATeam,
} from "@/lib/tba/types";
import MatchRow from "@/components/match/MatchRow";
import PageContainer from "@/components/ui/PageContainer";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";
import SurfaceCard from "@/components/ui/SurfaceCard";
import { formatEventDateRange } from "@/lib/time";
import {
  formatAllianceLongName,
  formatPlayoffMatchGroup,
  formatPlayoffLevel,
  formatTeamNumber,
  isEliminationMatch,
} from "@/lib/tba/formatters";

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ event: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { event: eventKey } = await params;
  const search = await searchParams;
  const selectedTab = Array.isArray(search.tab) ? search.tab[0] : search.tab;
  const activeTab = selectedTab === "teams" ? "teams" : "matches";

  if (!eventKey) {
    return (
      <SiteShell>
        <main className="min-h-full bg-[var(--fv-surface)] px-4 py-8 text-[var(--fv-text)] sm:px-6">
          <p className="text-[var(--fv-muted)]">Missing event key.</p>
        </main>
      </SiteShell>
    );
  }

  let event;
  let teams;
  let matches;
  let alliances;

  try {
    [event, teams, matches] = await Promise.all([
      TBA.getEvent(eventKey),
      TBA.getTeamsAtEvent(eventKey),
      TBA.getEventMatches(eventKey),
    ]);
    alliances = activeTab === "matches"
      ? await TBA.getEventPlayoffAlliances(eventKey)
      : null;
  } catch {
    return (
      <SiteShell>
        <main className="min-h-full bg-[var(--fv-surface)] px-4 py-8 text-[var(--fv-text)] sm:px-6">
          <div className="mx-auto max-w-5xl">
            <h1 className="text-2xl font-semibold">Event unavailable</h1>
            <p className="mt-2 text-[var(--fv-muted)]">
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
  const sortedTeams = [...teams].sort(
    (a: TBATeam, b: TBATeam) => a.team_number - b.team_number,
  );

  matches = [...matches].sort((a: TBAMatchSimple, b: TBAMatchSimple) => {
    const levelOrder: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
    return (levelOrder[a.comp_level] ?? 99) - (levelOrder[b.comp_level] ?? 99)
      || (a.set_number ?? 0) - (b.set_number ?? 0)
      || (a.match_number ?? 0) - (b.match_number ?? 0);
  });
  const qualificationMatches = matches.filter((match: TBAMatch) => match.comp_level === "qm");
  const playoffMatches = matches.filter((match: TBAMatch) => isEliminationMatch(match.comp_level));
  const playoffMatchesPanel = playoffMatches.length > 0 ? (
    <MatchGroup
      title="Playoff Matches"
      eventKey={event.key}
      playoffType={event.playoff_type ?? null}
      matches={playoffMatches}
      playoffAlliances={alliances}
      groupPlayoffsByRound
    />
  ) : null;
  const playoffAlliancesPanel = alliances?.length ? (
    <PlayoffAlliances
      alliances={alliances}
      playoffType={event.playoff_type}
    />
  ) : null;

  const dates = formatEventDateRange(event.start_date, event.end_date);

  return (
    <SiteShell>
      <main className="min-h-full bg-[var(--fv-surface)] text-[var(--fv-text)]">
        <PageContainer className="max-w-5xl">
          <SurfaceCard className="overflow-hidden rounded-2xl">
            <div className="p-5 sm:p-8">
              <PageHeader
                eyebrow={event.district?.display_name || "Competition event"}
                title={<><span>{event.name}</span><span className="rounded-full bg-[var(--fv-brand-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--fv-brand-strong)]">{event.event_type_string ?? event.event_type}</span></>}
                description={<div className="flex flex-wrap items-center gap-x-2 gap-y-1">{dates ? <span>{dates}</span> : null}{dates && (event.location_name || location) ? <span aria-hidden="true">·</span> : null}{event.location_name ? <span>{event.location_name}</span> : null}{event.location_name && location ? <span>in</span> : null}{location ? <span>{location}</span> : null}</div>}
                actions={<Link href={`/gameday?event=${event.key}`} className="inline-flex min-h-10 items-center rounded-lg bg-[var(--fv-brand)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--fv-brand-strong)]">Open Gameday</Link>}
                footer={<>{event.website ? <ExternalLink href={event.website} label="Event Website" /> : null}<ExternalLink href={`https://www.thebluealliance.com/event/${event.key}`} label="The Blue Alliance" /></>}
                className="border-0 pb-0 sm:items-start"
              />
            </div>
            <nav aria-label="Event information" className="flex min-w-0 gap-5 overflow-x-auto border-t border-[var(--fv-border)] px-5 sm:gap-6 sm:px-8">
              <TabLink
                href={`/event/${event.key}?tab=matches`}
                selected={activeTab === "matches"}
                label="Matches"
                count={matches.length}
              />
              <TabLink
                href={`/event/${event.key}?tab=teams`}
                selected={activeTab === "teams"}
                label="Teams"
                count={sortedTeams.length}
              />
              <Link
                href={`/insights/event/${event.key}`}
                className="border-b-2 border-transparent px-1 py-3 text-sm font-semibold text-[var(--fv-muted)] hover:text-[var(--fv-text)]"
              >
                Analytics
              </Link>
            </nav>
          </SurfaceCard>

          {activeTab === "teams" ? (
            <section id="teams" className="mt-6">
              <SectionHeading title="Teams" description={`${sortedTeams.length} teams registered for this event.`} className="mb-3" />
              <SurfaceCard className="overflow-hidden">
                {sortedTeams.length === 0 ? (
                  <p className="p-6 text-sm text-[var(--fv-muted)]">No teams are currently listed for this event.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-separate border-spacing-0 text-left text-sm">
                      <thead className="event-divider event-header-surface border-b border-slate-200 bg-[var(--fv-surface)] text-xs uppercase tracking-wide text-[var(--fv-muted)]">
                        <tr>
                          <th scope="col" className="px-5 py-3 font-medium">Team</th>
                          <th scope="col" className="px-5 py-3 font-medium">Location</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTeams.map((team: TBATeam) => (
                          <tr
                            key={team.key}
                            className="event-divider border-b border-[var(--fv-border)] last:border-b-0 hover:bg-[var(--fv-surface)]"
                          >
                            <td className="whitespace-nowrap px-5 py-3">
                              <Link
                                href={`/team/${team.team_number}?year=${event.year}`}
                                className="font-medium text-[var(--fv-text)] underline decoration-[var(--fv-muted)] underline-offset-4 hover:text-[var(--fv-text)]"
                              >
                                <span className="font-mono">{team.team_number}</span>
                                <span className="ml-3 text-[var(--fv-text)]">{team.nickname || team.name}</span>
                              </Link>
                            </td>
                            <td className="whitespace-nowrap px-5 py-3 text-[var(--fv-muted)]">
                              {[team.city, team.state_prov, team.country].filter(Boolean).join(", ") || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SurfaceCard>
            </section>
          ) : (
            <section id="matches" className="mt-6">
              <SectionHeading title="Match Schedule" description={`${matches.length} matches scheduled or recorded.`} className="mb-3" />
              <div className="mt-3 grid items-start gap-5 xl:grid-cols-2">
                {qualificationMatches.length > 0 ? (
                  <MatchGroup
                    title="Qualification Matches"
                    eventKey={event.key}
                    playoffType={event.playoff_type ?? null}
                    matches={qualificationMatches}
                    playoffAlliances={alliances}
                  />
                ) : (
                  playoffMatchesPanel
                )}
                {qualificationMatches.length > 0 ? (
                  playoffAlliancesPanel || playoffMatchesPanel ? (
                    <div className="space-y-5">
                      {playoffAlliancesPanel}
                      {playoffMatchesPanel}
                    </div>
                  ) : null
                ) : (
                  playoffAlliancesPanel
                )}
              </div>
            </section>
          )}
        </PageContainer>
      </main>
    </SiteShell>
  );
}

function TabLink({
  href,
  selected,
  label,
  count,
}: {
  href: string;
  selected: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      aria-current={selected ? "page" : undefined}
      className={`border-b-2 px-1 py-3 text-sm font-semibold ${
        selected
          ? "border-[var(--fv-brand)] text-[var(--fv-brand-strong)]"
          : "border-transparent text-[var(--fv-muted)] hover:text-[var(--fv-text)]"
      }`}
    >
      {label} <span className="ml-1 text-[var(--fv-muted)]">{count}</span>
    </Link>
  );
}

function MatchGroup({
  title,
  eventKey,
  playoffType,
  matches,
  playoffAlliances,
  groupPlayoffsByRound = false,
}: {
  title: string;
  eventKey: string;
  playoffType: number | null;
  matches: TBAMatch[];
  playoffAlliances: TBAEliminationAlliance[] | null;
  groupPlayoffsByRound?: boolean;
}) {
  const groupedMatches = groupPlayoffsByRound
    ? matches.reduce<{ title: string; matches: TBAMatch[] }[]>((groups, match) => {
        const groupTitle = formatPlayoffMatchGroup(match, playoffType);
        const group = groups.find((entry) => entry.title === groupTitle);
        if (group) {
          group.matches.push(match);
        } else {
          groups.push({ title: groupTitle, matches: [match] });
        }
        return groups;
      }, [])
    : [{ title: "", matches }];

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)]">
      <h3 className="event-divider event-header-surface border-b border-slate-200 bg-[var(--fv-surface)] px-3 py-2 text-sm font-semibold">
        {title} <span className="font-normal text-[var(--fv-muted)]">{matches.length}</span>
      </h3>
      {matches.length === 0 ? (
        <p className="px-3 py-4 text-sm text-[var(--fv-muted)]">No matches are currently available.</p>
      ) : (
        groupedMatches.map((group) => (
          <div key={group.title || "all-matches"}>
            {group.title && (
              <div className="event-divider event-header-surface border-t border-slate-200 bg-[var(--fv-surface)] px-3 py-2 first:border-t-0 last:border-b-0">
                <h4 className="text-center text-xs font-semibold uppercase tracking-wide text-[var(--fv-muted)]">
                  {group.title}
                </h4>
              </div>
            )}
            {group.matches.map((match, index) => (
              <MatchRow
                compact
                eventKey={eventKey}
                firstInGroup={index === 0}
                key={match.key}
                match={match}
                playoffType={playoffType}
                playoffAlliances={playoffAlliances}
              />
            ))}
          </div>
        ))
      )}
    </section>
  );
}

function PlayoffAlliances({
  alliances,
  playoffType,
}: {
  alliances: TBAEliminationAlliance[] | null;
  playoffType: number | null;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)]">
      <h3 className="event-divider event-header-surface border-b border-slate-200 bg-[var(--fv-surface)] px-3 py-2 text-sm font-semibold">
        Playoff Alliances <span className="font-normal text-[var(--fv-muted)]">{alliances?.length ?? 0}</span>
      </h3>
      {!alliances?.length ? (
        <p className="px-3 py-4 text-sm text-[var(--fv-muted)]">Playoff alliances are not available yet.</p>
      ) : (
        <div>
          {alliances.map((alliance, index) => {
            const playoffLevel = formatPlayoffLevel(alliance, playoffType);
            const status = alliance.status?.status;
            const isWinner = status === "won";
            const isEliminatedFinalist =
              status === "eliminated" && playoffLevel === "Finals";

            return (
              <div
                key={alliance.name ?? index}
                className="event-divider flex items-center gap-3 border-b border-[var(--fv-border)] px-3 py-2 last:border-b-0"
              >
                <span className="w-28 shrink-0 truncate text-xs font-semibold text-[var(--fv-muted)]">
                  {formatAllianceLongName(alliance.name, index)}
                </span>
                <div className="flex min-w-0 flex-wrap gap-1">
                  {alliance.picks.map((teamKey) => (
                    <Link
                      key={teamKey}
                      href={`/team/${teamKey}`}
                      className="rounded border border-[var(--fv-border)] bg-[var(--fv-surface)] px-1.5 py-0.5 font-mono text-xs font-semibold text-[var(--fv-text)] hover:bg-[var(--fv-surface)]"
                    >
                      {formatTeamNumber(teamKey)}
                    </Link>
                  ))}
                </div>
                {status && (
                  <div className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
                    <span className="flex items-center gap-1.5">
                      {isWinner || isEliminatedFinalist ? (
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 20 20"
                          className={`h-3.5 w-3.5 ${
                            isWinner ? "text-amber-500" : "text-[var(--fv-muted)]"
                          }`}
                          fill="currentColor"
                        >
                          <path d="M2 5.5 6.25 8 10 2l3.75 6L18 5.5 16.75 15H3.25L2 5.5Zm1.75 11h12.5V18H3.75v-1.5Z" />
                        </svg>
                      ) : (
                        <span
                          aria-hidden="true"
                          className={`h-2 w-2 rounded-full ${
                            status === "playing" ? "bg-green-600" : "bg-red-600"
                          }`}
                        />
                      )}
                      <span className="font-medium capitalize text-[var(--fv-text)]">
                        {status === "won" ? "Winner" : status}
                      </span>
                    </span>
                    <span className="font-mono text-[var(--fv-muted)]">{playoffLevel}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-4 py-2 text-sm text-[var(--fv-muted)] transition hover:bg-[var(--fv-surface)] hover:text-[var(--fv-text)]"
    >
      {label}
    </a>
  );
}
