/**
 * Temporary analytics-facing compatibility projection for the legacy web
 * application. This is not provider normalization or a canonical domain type:
 * the FRC Colors response remains unchanged at the provider/runtime boundary.
 */
export type FRCColor = {
  teamNumber: number;
  primaryHex: string | null;
  secondaryHex: string | null;
  verified: boolean | null;
};

export type LegacyFRCColorsEventResponse = {
  teams?: Record<string, {
    teamNumber?: number;
    colors?: {
      primaryHex?: string | null;
      secondaryHex?: string | null;
      verified?: boolean;
    } | null;
  }>;
};

function validHex(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase()
    : null;
}

/** Preserve the existing analytics response shape while the legacy consumer remains. */
export function toLegacyFRCColors(payload: LegacyFRCColorsEventResponse): FRCColor[] {
  return Object.entries(payload.teams ?? {}).flatMap(([key, team]) => {
    const teamNumber = Number(team.teamNumber ?? key);
    if (!Number.isSafeInteger(teamNumber) || teamNumber <= 0) return [];
    return [{
      teamNumber,
      primaryHex: validHex(team.colors?.primaryHex),
      secondaryHex: validHex(team.colors?.secondaryHex),
      verified: typeof team.colors?.verified === "boolean" ? team.colors.verified : null,
    }];
  });
}
