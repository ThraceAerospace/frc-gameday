/** Team identity colors returned by GET /v1/team/:teamNumber. */
export interface FRCColorsTeam {
  primaryHex?: string | null;
  secondaryHex?: string | null;
  verified?: boolean | null;
}
