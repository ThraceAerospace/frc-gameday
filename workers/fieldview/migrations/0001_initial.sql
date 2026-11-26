-- FieldView D1 baseline schema.
-- Discovery and System Records are separate logical ownership domains in one D1 database.
-- Timestamps are Unix milliseconds. Provider payloads and DTO snapshots are stored as JSON.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS discovery_current_season (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  year INTEGER NOT NULL CHECK (year BETWEEN 1992 AND 2200),
  max_team_page INTEGER,
  status_json TEXT NOT NULL CHECK (json_valid(status_json)),
  checked_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS discovery_team_directory_runs (
  year INTEGER NOT NULL CHECK (year BETWEEN 1992 AND 2200),
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'partial', 'completed', 'failed')),
  expected_page_count INTEGER NOT NULL CHECK (expected_page_count >= 0),
  successful_page_count INTEGER NOT NULL DEFAULT 0 CHECK (successful_page_count >= 0),
  failed_pages_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(failed_pages_json)),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
  team_count INTEGER NOT NULL DEFAULT 0 CHECK (team_count >= 0),
  started_at INTEGER NOT NULL,
  checked_at INTEGER,
  PRIMARY KEY (year, generation)
) STRICT;

CREATE TABLE IF NOT EXISTS discovery_team_pages (
  year INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number >= 0),
  team_keys_json TEXT NOT NULL CHECK (json_valid(team_keys_json)),
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (year, generation, page_number),
  FOREIGN KEY (year, generation) REFERENCES discovery_team_directory_runs(year, generation) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS discovery_teams (
  year INTEGER NOT NULL,
  team_key TEXT NOT NULL CHECK (team_key GLOB 'frc[0-9]*'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (year, team_key),
  UNIQUE (year, ordinal)
) STRICT;

CREATE INDEX IF NOT EXISTS discovery_teams_by_ordinal ON discovery_teams(year, ordinal);

CREATE TABLE IF NOT EXISTS discovery_event_directory_runs (
  year INTEGER NOT NULL CHECK (year BETWEEN 1992 AND 2200),
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'published', 'failed')),
  etag TEXT,
  chunk_size INTEGER NOT NULL CHECK (chunk_size BETWEEN 1 AND 100),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  directory_json TEXT CHECK (directory_json IS NULL OR json_valid(directory_json)),
  event_keys_json TEXT CHECK (event_keys_json IS NULL OR json_valid(event_keys_json)),
  started_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (year, generation)
) STRICT;

CREATE TABLE IF NOT EXISTS discovery_event_chunks (
  year INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  events_json TEXT NOT NULL CHECK (json_valid(events_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (year, generation, chunk_index),
  FOREIGN KEY (year, generation) REFERENCES discovery_event_directory_runs(year, generation) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS discovery_events (
  year INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  provider_event_json TEXT NOT NULL CHECK (json_valid(provider_event_json)),
  PRIMARY KEY (year, event_key),
  UNIQUE (year, ordinal)
) STRICT;

CREATE INDEX IF NOT EXISTS discovery_events_by_ordinal ON discovery_events(year, ordinal);

CREATE TABLE IF NOT EXISTS discovery_week_projections (
  projection_key TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 1992 AND 2200),
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  evaluated_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json))
) STRICT;

-- System Records owns execution, registration, administration, and operational history.
CREATE TABLE IF NOT EXISTS system_runtime_registrations (
  runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('event', 'team')),
  runtime_key TEXT NOT NULL,
  season INTEGER NOT NULL CHECK (season BETWEEN 1992 AND 2200),
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  PRIMARY KEY (runtime_kind, runtime_key)
) STRICT;

CREATE INDEX IF NOT EXISTS system_runtime_registrations_by_season
  ON system_runtime_registrations(runtime_kind, season, runtime_key);

CREATE TABLE IF NOT EXISTS system_workflow_runs (
  workflow_id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  status TEXT NOT NULL,
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN ('event', 'team', 'season', 'system')),
  subject_key TEXT,
  season INTEGER CHECK (season IS NULL OR season BETWEEN 1992 AND 2200),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  error_text TEXT,
  retention_until INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS system_workflow_runs_by_type_started
  ON system_workflow_runs(workflow_type, started_at DESC);
CREATE INDEX IF NOT EXISTS system_workflow_runs_by_subject
  ON system_workflow_runs(subject_kind, subject_key, started_at DESC);
CREATE INDEX IF NOT EXISTS system_workflow_runs_by_status
  ON system_workflow_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS system_workflow_run_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  FOREIGN KEY (workflow_id) REFERENCES system_workflow_runs(workflow_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS system_workflow_run_events_by_workflow
  ON system_workflow_run_events(workflow_id, event_id);

CREATE TABLE IF NOT EXISTS system_workflow_run_results (
  workflow_id TEXT NOT NULL,
  result_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, result_key),
  FOREIGN KEY (workflow_id) REFERENCES system_workflow_runs(workflow_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS system_admin_jobs (
  workflow_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('event', 'team', 'season', 'system')),
  subject_key TEXT NOT NULL,
  season INTEGER CHECK (season IS NULL OR season BETWEEN 1992 AND 2200),
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_text TEXT,
  FOREIGN KEY (workflow_id) REFERENCES system_workflow_runs(workflow_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS system_admin_jobs_by_subject
  ON system_admin_jobs(operation, subject_kind, subject_key, requested_at DESC);

CREATE TABLE IF NOT EXISTS system_admin_job_heads (
  operation TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation, subject_kind, subject_key),
  FOREIGN KEY (workflow_id) REFERENCES system_admin_jobs(workflow_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS system_admin_job_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
) STRICT;

CREATE INDEX IF NOT EXISTS system_admin_job_history_lookup
  ON system_admin_job_history(operation, subject_kind, subject_key, archived_at DESC);

CREATE TABLE IF NOT EXISTS system_discovery_jobs (
  season INTEGER PRIMARY KEY CHECK (season BETWEEN 1992 AND 2200),
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
) STRICT;

CREATE TABLE IF NOT EXISTS system_coverage_audits (
  season INTEGER PRIMARY KEY CHECK (season BETWEEN 1992 AND 2200),
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  items_prefix TEXT,
  counts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts_json)),
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
) STRICT;

CREATE TABLE IF NOT EXISTS system_coverage_audit_items (
  season INTEGER NOT NULL,
  workflow_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('event', 'team')),
  registered INTEGER NOT NULL CHECK (registered IN (0, 1)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (season, workflow_id, item_key),
  FOREIGN KEY (season) REFERENCES system_coverage_audits(season) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS system_coverage_audit_items_by_run
  ON system_coverage_audit_items(season, workflow_id, item_kind, item_key);

CREATE TABLE IF NOT EXISTS system_admin_actions (
  action_id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  subject_kind TEXT,
  subject_key TEXT,
  workflow_id TEXT,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(request_json)),
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  error_text TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS system_admin_actions_by_subject
  ON system_admin_actions(subject_kind, subject_key, requested_at DESC);

CREATE TABLE IF NOT EXISTS system_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  occurred_at INTEGER NOT NULL,
  subject_kind TEXT,
  subject_key TEXT,
  workflow_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json))
) STRICT;

CREATE INDEX IF NOT EXISTS system_events_by_type_time
  ON system_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS system_events_by_subject_time
  ON system_events(subject_kind, subject_key, occurred_at DESC);

-- Transitional escape hatch for key/value records while callers are migrated.
-- New code should use typed repositories/tables above; do not place canonical runtime state here.
CREATE TABLE IF NOT EXISTS system_records (
  record_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS system_records_by_expiry ON system_records(expires_at);
