import type { TBATeam } from "@fieldview/provider-tba/types";
import type { FieldViewTeam } from "../team.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";

/** Attach FieldView provenance without changing any provider-owned team field. */
export function normalizeFieldViewTeam(
  tba_team: TBATeam,
  sources: FieldViewSourceMetadata,
  frc_colors?: FieldViewTeam["frc_colors"],
): FieldViewTeam {
  return { ...tba_team, sources, ...(frc_colors === undefined ? {} : { frc_colors }) };
}
