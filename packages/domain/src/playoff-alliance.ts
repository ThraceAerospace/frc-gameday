import type { TBAEliminationAlliance } from "@fieldview/provider-tba/types";
import type { EventKey } from "./ids.js";
import type { FieldViewSourceMetadata } from "./source-metadata.js";

/**
 * Canonical event-scoped playoff alliance. All original TBA elimination
 * alliance fields and their types are retained; event_key establishes the
 * FieldView relationship to its event.
 */
export interface FieldViewPlayoffAlliance extends TBAEliminationAlliance {
  event_key: EventKey;
  /** Provenance for the event playoff-alliance and advancement resources. */
  sources: FieldViewSourceMetadata;
}
