import type { TBAEliminationAlliance } from "@fieldview/provider-tba/types";
import type { EventKey } from "../ids.js";
import type { FieldViewPlayoffAlliance } from "../playoff-alliance.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";

/** Attach the owning event and provenance without rewriting TBA alliance fields. */
export function normalizeFieldViewPlayoffAlliance(
  tba_alliance: TBAEliminationAlliance,
  event_key: EventKey,
  sources: FieldViewSourceMetadata,
): FieldViewPlayoffAlliance {
  return { ...tba_alliance, event_key, sources };
}
