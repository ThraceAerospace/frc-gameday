/** Acquisition state for one provider resource; distinct from its data value. */
export type FieldViewSourceStatus =
  | "available"
  | "stale"
  | "unavailable"
  | "failed";

/** Internal provenance/freshness metadata for one acquired resource. */
export interface FieldViewSourceRecordMetadata {
  status: FieldViewSourceStatus;
  /** ISO-8601 UTC retrieval time. */
  retrieved_at: string | null;
  /** Provider-supplied update time, when that resource exposes one. */
  source_updated_at?: string | null;
  /** Provider/cache validator, when available. */
  validator?: string | null;
}

/**
 * Resource-specific metadata. Separate keys prevent a successful match fetch
 * from implying that predictions, OPRs, or playoff data are also fresh.
 */
export interface FieldViewSourceMetadata {
  tba_match?: FieldViewSourceRecordMetadata;
  tba_event_predictions?: FieldViewSourceRecordMetadata;
  tba_event_oprs?: FieldViewSourceRecordMetadata;
  tba_playoff_alliances?: FieldViewSourceRecordMetadata;
  tba_playoff_advancement?: FieldViewSourceRecordMetadata;
  tba_team_event_status?: FieldViewSourceRecordMetadata;
  statbotics_match?: FieldViewSourceRecordMetadata;
  statbotics_team_year?: FieldViewSourceRecordMetadata;
}
