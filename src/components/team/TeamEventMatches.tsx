import Link from "next/link";
import type { TBAEventSimple, TBAMatch } from "@/lib/tba/types";
import TeamMatch from "./TeamMatch";

export default function TeamEventMatches({
  event,
  matches,
  teamKey,
}: {
  event: TBAEventSimple;
  matches: TBAMatch[];
  teamKey: string;
}) {
  return (
    <section className="border-t border-slate-200 first:border-t-0">
      <div className="bg-slate-50 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <Link
            href={`/event/${event.key}`}
            className="font-bold text-slate-900 hover:text-blue-600"
          >
            {event.name}
          </Link>
          <span className="text-xs text-slate-400">
            {matches.length} match{matches.length === 1 ? "" : "es"}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {event.start_date} – {event.end_date}
        </p>
      </div>

      {matches.map((match) => (
        <TeamMatch
          key={match.key}
          event={event}
          match={match}
          teamKey={teamKey}
        />
      ))}
    </section>
  );
}
