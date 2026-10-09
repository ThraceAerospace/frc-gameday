import Link from "next/link";
import type { TBAEliminationAlliance, TBAEventSimple, TBAMatch } from "@/lib/tba/types";
import TeamMatch from "./TeamMatch";

export default function TeamEventMatches({
  event,
  matches,
  highlightedTeamKeys,
  playoffAlliances,
}: {
  event: TBAEventSimple & { playoff_type?: number | null };
  matches: TBAMatch[];
  highlightedTeamKeys: string[];
  playoffAlliances?: TBAEliminationAlliance[] | null;
}) {
  return (
    <section className="border-t border-slate-200 first:border-t-0">
      <div className="bg-slate-50 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <Link
            href={`/event/${event.key}`}
            className="font-bold text-slate-900 hover:text-blue-600"
          >
            {event.name}
          </Link>
          <span className="text-xs text-slate-500">
            {event.city}
            {event.state_prov ? `, ${event.state_prov}` : ""}
            {" · "}
            {event.start_date} – {event.end_date}
            {" · "}
            {matches.length} match{matches.length === 1 ? "" : "es"}
          </span>
        </div>
      </div>

      {matches.length === 0 ? (
        <div className="px-4 py-3 text-sm text-slate-500">No matches.</div>
      ) : (
        matches.map((match) => (
          <TeamMatch
            key={match.key}
            event={event}
            match={match}
            highlightedTeamKeys={highlightedTeamKeys}
            playoffAlliances={playoffAlliances}
          />
        ))
      )}
    </section>
  );
}
