import type { TBAEvent } from "@fieldview/provider-tba/types";
import type { FieldViewEvent } from "../event.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";

/** Attach FieldView provenance without changing any provider-owned event field. */
export function normalizeFieldViewEvent(
  tba_event: TBAEvent,
  sources: FieldViewSourceMetadata,
): FieldViewEvent {
  return { ...tba_event, sources };
}
