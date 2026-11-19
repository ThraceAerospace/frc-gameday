import type { TBATeam } from "@fieldview/provider-tba/types";
import type { FieldViewTeam } from "../team.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";
import type { FRCColorsTeam } from "@fieldview/provider-frc-colors/types";

/** Attach FieldView provenance without changing any provider-owned team field. */
export function normalizeFieldViewTeam(
  tba_team: TBATeam,
  sources: FieldViewSourceMetadata,
  frc_colors?: FRCColorsTeam | null,
): FieldViewTeam {
  const normalizedColors = frc_colors === undefined ? undefined : frc_colors === null ? null : {
    primary_hex: typeof frc_colors.primaryHex === "string" && /^#[0-9a-f]{6}$/i.test(frc_colors.primaryHex)
      ? frc_colors.primaryHex.toUpperCase() : null,
    secondary_hex: typeof frc_colors.secondaryHex === "string" && /^#[0-9a-f]{6}$/i.test(frc_colors.secondaryHex)
      ? frc_colors.secondaryHex.toUpperCase() : null,
    verified: typeof frc_colors.verified === "boolean" ? frc_colors.verified : null,
  };
  return { ...tba_team, sources, ...(normalizedColors === undefined ? {} : { frc_colors: normalizedColors }) };
}
