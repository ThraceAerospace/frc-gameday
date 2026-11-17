/**
 * Availability of the best usable version of one provider resource.
 * - available: the retained version is current.
 * - stale: a previously usable version is retained but is not current; this
 *   includes a failed refresh when older usable data remains available.
 * - unavailable: the provider authoritatively indicates that the resource is
 *   not available (for example, an endpoint-specific not-found response).
 * - failed: acquisition failed and no usable retained version is available.
 *
 * No metadata entry means no acquisition state has been recorded; it does not
 * mean that the resource is unavailable or that its value is null.
 */
export type FieldViewSourceStatus =
  | "available"
  | "stale"
  | "unavailable"
  | "failed";

/**
 * Internal provenance/freshness metadata for one provider resource.
 *
 * The discriminated union prevents contradictory states: current or stale
 * data must identify its retained payload version, while unavailable/failed
 * resources have no retained usable version.
 */
export type FieldViewSourceRecordMetadata =
  | {
      status: "available" | "stale";
      /** ISO-8601 UTC time of the retained payload version. */
      retrieved_at: string;
      /** Provider-supplied update time, when that resource exposes one. */
      source_updated_at?: string | null;
      /** Provider/cache validator, when available. */
      validator?: string | null;
    }
  | {
      status: "unavailable" | "failed";
      /** No usable payload version is retained. */
      retrieved_at: null;
      /** Provider-supplied update time, when that resource exposes one. */
      source_updated_at?: string | null;
      /** Provider/cache validator, when available. */
      validator?: string | null;
    };

/**
 * Resource-specific metadata. Separate keys prevent a successful match fetch
 * from implying that predictions, OPRs, or playoff data are also fresh.
 */
export interface FieldViewSourceMetadata {
  tba_team?: FieldViewSourceRecordMetadata;
  tba_teams?: FieldViewSourceRecordMetadata;
  tba_event?: FieldViewSourceRecordMetadata;
  tba_match?: FieldViewSourceRecordMetadata;
  tba_event_predictions?: FieldViewSourceRecordMetadata;
  tba_event_oprs?: FieldViewSourceRecordMetadata;
  tba_playoff_alliances?: FieldViewSourceRecordMetadata;
  tba_playoff_advancement?: FieldViewSourceRecordMetadata;
  tba_team_event_status?: FieldViewSourceRecordMetadata;
  statbotics_match?: FieldViewSourceRecordMetadata;
  statbotics_team_year?: FieldViewSourceRecordMetadata;
}
