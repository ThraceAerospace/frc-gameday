import type { TBAEvent } from "@fieldview/provider-tba/types";

/**
 * The TBA event payload as received.
 *
 * This is a direct type alias: field names, values, nullability, and structure
 * are unchanged. In particular, timezone retains the nullable type from TBA.
 * Any future FieldView-derived values must be separate, explicitly named
 * fields with documented and approved transformations.
 */
export type FieldViewEvent = TBAEvent;
