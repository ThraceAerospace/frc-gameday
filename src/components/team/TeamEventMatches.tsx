import type { TBAEliminationAlliance, TBAEvent, TBAMatch } from "@/lib/tba/types";
import MatchRow from "@/components/match/MatchRow";

export default function TeamEventMatches({
  event,
  matches,
  highlightedTeamKeys,
  playoffAlliances,
}: {
  event: TBAEvent;
  matches: TBAMatch[];
  highlightedTeamKeys: string[];
  playoffAlliances?: TBAEliminationAlliance[] | null;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h4 className="text-sm font-bold text-slate-800">Matches</h4>
        <span className="text-xs text-slate-500">{matches.length} match{matches.length === 1 ? "" : "es"}</span>
      </div>
      {matches.length === 0 ? (
        <div className="px-4 py-4 text-sm text-slate-500">No matches.</div>
      ) : (
        matches.map((match) => (
          <MatchRow key={match.key} eventKey={event.key} playoffType={event.playoff_type ?? null} match={match} highlightedTeamKeys={highlightedTeamKeys} playoffAlliances={playoffAlliances} />
        ))
      )}
    </div>
  );
}
