import { redis } from "@/lib/cache/redis";
import { TBA } from "@/lib/tba/service";
import { Statbotics } from "@/lib/statbotics/service";
import { sortMatches } from "@/lib/tba/matchUtils";
import type { StatboticsEPA, StatboticsMatch } from "@/lib/statbotics/types";
import type { TBAMatch, TBAEventSimple } from "@/lib/tba/types";

type TeamMatchRow = {
  matchKey: string;
  matchLabel: string;
  compLevel: string;
  event: { key: string; name: string; shortName?: string | null; startDate: string };
  partners: string[];
  opponents: string[];
  alliance: "red" | "blue";
  predicted: number | null;
  actual: number | null;
  residual: number | null;
  opponentPredicted: number | null;
  opponentActual: number | null;
  redWinProbability: number | null;
  teamWinProbability: number | null;
  won: boolean | null;
  preEPA: number | null;
  postEPA: number | null;
  deltaEPA: number | null;
  preComponents: Record<string, number>;
  postComponents: Record<string, number>;
  allianceDeltaSpread: number | null;
  sharedAllianceUpdate: boolean;
  statboticsAvailable: boolean;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function teamEPA(record: StatboticsMatch, teamNumber: number, phase: "pre_epas" | "epas"): StatboticsEPA | undefined {
  return record[phase]?.[String(teamNumber)];
}
function components(value: StatboticsEPA | undefined): Record<string, number> {
  if (!value) return {};
  const result: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value)) {
    if (typeof amount === "number" && Number.isFinite(amount) && !/^comp_\\d+_epa$/.test(key)) result[key] = amount;
  }
  return result;
}
function label(match: TBAMatch): string {
  if (match.comp_level === "qm" || match.comp_level === "pm") return `QM ${match.match_number}`;
  return `${match.comp_level.toUpperCase()} ${match.set_number} · ${match.match_number}`;
}
async function withConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await worker(items[index]);
    }
  }));
  return result;
}

export async function GET(request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  if (!/^\\d{1,6}$/.test(rawTeam)) return Response.json({ error: "Invalid team number" }, { status: 400 });
  const teamNumber = Number(rawTeam);
  const year = Number(new URL(request.url).searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 1992 || year > new Date().getFullYear() + 1) return Response.json({ error: "Invalid season year" }, { status: 400 });

  const cacheKey = `cache:insights:team-match-analysis:${teamNumber}:${year}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    try { return Response.json(JSON.parse(cached)); } catch { await redis.del(cacheKey); }
  }

  try {
    const events = (await TBA.getTeamEvents(`frc${teamNumber}`, year))
      .filter((event: TBAEventSimple) => event.event_type !== 99 && event.event_type !== 100)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    const eventMatches = await withConcurrency(events, 4, async (event) => ({
      event,
      matches: sortMatches(await TBA.getTeamMatches(`frc${teamNumber}`, event.key)),
    }));
    const allMatches = eventMatches.flatMap(({ event, matches }) => matches.map((match) => ({ event, match })));
    const rows = await withConcurrency(allMatches, 4, async ({ event, match }) => {
      let statbotics: StatboticsMatch | null = null;
      try { statbotics = await Statbotics.getMatch(match.key); } catch { /* retain TBA match data */ }
      const red = match.alliances.red.team_keys ?? [];
      const blue = match.alliances.blue.team_keys ?? [];
      const alliance = red.includes(`frc${teamNumber}`) ? "red" : blue.includes(`frc${teamNumber}`) ? "blue" : null;
      if (!alliance) return null;
      const own = match.alliances[alliance];
      const otherColor = alliance === "red" ? "blue" : "red";
      const other = match.alliances[otherColor];
      const predicted = finite(alliance === "red" ? statbotics?.pred?.red_score ?? statbotics?.prediction?.red_score : statbotics?.pred?.blue_score ?? statbotics?.prediction?.blue_score);
      const opponentPredicted = finite(alliance === "red" ? statbotics?.pred?.blue_score ?? statbotics?.prediction?.blue_score : statbotics?.pred?.red_score ?? statbotics?.prediction?.red_score);
      const actual = finite(own.score) !== null && own.score >= 0 ? own.score : null;
      const opponentActual = finite(other.score) !== null && other.score >= 0 ? other.score : null;
      const redProbability = finite(statbotics?.pred?.red_win_prob ?? statbotics?.prediction?.red_win_prob);
      const teamProbability = redProbability === null ? null : alliance === "red" ? redProbability : 1 - redProbability;
      const pre = teamEPA(statbotics ?? {}, teamNumber, "pre_epas");
      const post = teamEPA(statbotics ?? {}, teamNumber, "epas");
      const preEPA = finite(pre?.epa);
      const postEPA = finite(post?.epa);
      const deltaEPA = preEPA !== null && postEPA !== null ? postEPA - preEPA : null;
      const allianceDeltas = own.team_keys.map((key) => {
        const id = Number(key.replace(/^frc/i, ""));
        const before = finite(teamEPA(statbotics ?? {}, id, "pre_epas")?.epa);
        const after = finite(teamEPA(statbotics ?? {}, id, "epas")?.epa);
        return before !== null && after !== null ? after - before : null;
      }).filter((value): value is number => value !== null);
      const spread = allianceDeltas.length === own.team_keys.length && allianceDeltas.length > 1
        ? Math.max(...allianceDeltas) - Math.min(...allianceDeltas)
        : null;
      return {
        matchKey: match.key, matchLabel: label(match), compLevel: match.comp_level,
        event: { key: event.key, name: event.name, shortName: event.short_name, startDate: event.start_date },
        partners: own.team_keys.filter((key) => key !== `frc${teamNumber}`).map((key) => key.replace(/^frc/i, "")),
        opponents: other.team_keys.map((key) => key.replace(/^frc/i, "")),
        alliance, predicted, actual, residual: predicted !== null && actual !== null ? actual - predicted : null,
        opponentPredicted, opponentActual, redWinProbability: redProbability, teamWinProbability: teamProbability,
        won: match.winning_alliance === "red" || match.winning_alliance === "blue" ? match.winning_alliance === alliance : null,
        preEPA, postEPA, deltaEPA, preComponents: components(pre), postComponents: components(post),
        allianceDeltaSpread: spread, sharedAllianceUpdate: spread !== null && spread < 0.000001,
        statboticsAvailable: statbotics !== null,
      } satisfies TeamMatchRow;
    });
    const completed = rows.filter((row): row is TeamMatchRow => row !== null);
    const payload = {
      team: teamNumber, year, eventCount: events.length, matchCount: completed.length,
      matches: completed,
      collection: { state: completed.every((row) => row.statboticsAvailable) ? "complete" : "partial", statboticsMatches: completed.filter((row) => row.statboticsAvailable).length, totalMatches: completed.length, updatedAt: Date.now() },
    };
    await redis.set(cacheKey, JSON.stringify(payload), "EX", 10 * 60);
    return Response.json(payload, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (error) {
    console.error("[Insights] team match analysis failed", teamNumber, year, error);
    return Response.json({ error: "Team match analysis is temporarily unavailable" }, { status: 502 });
  }
}
