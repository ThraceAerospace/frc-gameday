import type { TBAEventSimple, TBAMatch } from "@/lib/tba/types";
import MatchRow from "@/components/matches/MatchRow";

export default function TeamMatch({
  event,
  match,
  highlightedTeamKeys,
  playoffAlliances,
}: {
  event: TBAEventSimple & { playoff_type?: number | null };
  match: TBAMatch;
  highlightedTeamKeys: string[];
  playoffAlliances?: import("@/lib/tba/types").TBAEliminationAlliance[] | null;
}) {
  return (
    <MatchRow
      eventKey={event.key}
      playoffType={event.playoff_type ?? null}
      match={match}
      highlightedTeamKeys={highlightedTeamKeys}
      playoffAlliances={playoffAlliances}
    />
  );
}
