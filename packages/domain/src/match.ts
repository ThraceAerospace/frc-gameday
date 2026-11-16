import type { TBAMatch } from "@fieldview/provider-tba/types";

/**
 * The TBA match payload as received.
 *
 * This is a direct type alias: field names, competition-level values,
 * timestamps, nullability, alliance structure, and all other values remain
 * exactly as defined by TBA. Any future FieldView-derived values must be
 * separate, explicitly named fields with documented and approved
 * transformations.
 */
export type FieldViewMatch = TBAMatch;
