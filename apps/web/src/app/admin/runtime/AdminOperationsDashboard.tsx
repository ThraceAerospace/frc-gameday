"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import WorkflowRunsPanel from "./WorkflowRunsPanel";

type Kind = "event" | "team";
type Endpoint = {
  endpoint: string; status?: string; revision?: number;
  lastFetchedAt?: number | null; lastAttemptAt?: number | null;
  last_fetched_at?: number | null; last_attempt_at?: number | null;
  lastHttpStatus?: number | null; http_status?: number | null;
  lastError?: string | null; last_error?: string | null;
  record_count?: number; included_count?: number; excluded_count?: number;
};
type Task = { endpoint: string; due_at: number; interval_ms: number | null; attempts: number; retry_on_failure?: boolean };
type EntityState = {
  event_key?: string; team_key?: string;
  event_state?: { status?: string; generated_at?: number | null; source_revision?: number | null };
  analytics?: { status?: string; due_at?: number | null; last_calculated_at?: number | null; source_revision?: number | null; season_team_revision?: number | null; last_error?: string | null };
  lifecycle?: { completed_until?: number | null };
  endpoints?: Record<string, Endpoint> | Endpoint[];
  polling?: Task[];
  diagnostics?: Array<{ endpoint: string; http_status: number | null; last_error: string | null }>;
};
type Entity = { key: string; status: number; error?: string; state?: EntityState | null };
type TeamSeedJob = {
  teamKey: string; year: number; status: "running" | "completed" | "completed_with_errors" | "not_started";
  stage?: "seed" | "wait" | "events"; eventKeys?: string[]; eventCursor?: number; scheduledEvents?: number;
  attempts?: number; errors?: Array<{ event_key: string; detail: string; at?: number }>;
  startedAt?: number; updatedAt?: number;
};
type DiscoveryJob = {
  year: number; mode: "year"; status: "running" | "paused" | "completed" | "failed" | "cancelled" | "not_started";
  stage?: string; events?: number; teams?: number; steps?: number; error?: string | null;
  startedAt?: number; updatedAt?: number;
};
type EventTeamSeed = {
  eventKey: string; year: number; status: "running" | "completed" | "completed_with_errors" | "not_started";
  teamKeys?: string[]; cursor?: number; activeTeamKey?: string | null; seededTeams?: number;
  failedTeams?: number; historicalEventsScheduled?: number; errors?: Array<{ team_key: string; detail: string }>;
  updatedAt?: number;
};
type Overview = {
  generated_at: string;
  current_season?: { year: number | null; status: "missing" | "stale" | "available"; event_count: number; updated_at: number | null; checked_at: number | null };
  events: Entity[]; teams: Entity[];
  multiplexer: { connected_sockets: number | null; clients: number; subscriptions: Array<{ topic: string; clients: number }> } | null;
  inventory?: { events: number; teams: number }; truncated: boolean;
};
type InventoryPage = { total: number; cursor: number; next_cursor: number | null; keys: string[]; year?: number; discovery_ready?: boolean };
type SeasonIngest = {
  year: number; status: "not_started" | "running" | "paused" | "completed" | "completed_with_errors" | "cancelled"; history_count?: number;
  phase?: "teams" | "events" | "complete";
  team_cursor?: number; team_total?: number; team_resource_cursor?: number; team_resources_per_team?: number;
  event_cursor?: number; event_total?: number; event_resource_cursor?: number; event_resources_per_event?: number; team_snapshot_revision?: number; next_due_at?: number | null;
  counts?: {
    teams_complete: number; teams_partial: number; teams_failed: number;
    event_state_complete: number; event_state_partial: number; event_state_missing: number; event_state_failed: number;
    event_analytics_succeeded: number; event_analytics_partial: number; event_analytics_waiting: number; event_analytics_missing: number; event_analytics_failed: number;
    event_cohort_complete: number; event_cohort_partial: number; event_cohort_discovering: number; event_cohort_missing: number;
    requests_attempted: number; requests_succeeded: number; requests_failed: number; requests_retried: number;
    requests_skipped: number; requests_unavailable: number; requests_deferred: number;
  };
  recent_errors?: Array<{ kind: string; key: string; detail: string; at: number }>;
};
type SeasonPreview = {
  year: number; ready: boolean; runtime_ready?: boolean; ready_reason?: string | null; events: number; teams: number; team_pages: number;
  event_resources_per_event?: number; team_resources_per_team?: number;
  planned_resource_requests?: number; request_interval_ms?: number; estimated_minimum_duration_ms?: number;
  estimate_note?: string; existing_job?: SeasonIngest | null; history_count?: number;
};
type CoverageAudit = {
  year: number; status: "not_started" | "running" | "paused" | "completed" | "stale" | "failed" | "cancelled"; discovery_ready?: boolean;
  started_at?: number; updated_at?: number; cursor?: number; processed?: number; total?: number; remaining?: number;
  counts?: { events_total: number; events_happened: number; events_active: number; events_upcoming: number; events_invalid_dates: number; teams_total: number; team_pages: number; event_runtime_missing: number; team_runtime_missing: number; event_state_complete: number; event_state_partial: number; event_state_stale: number; event_state_missing: number; event_state_failed: number; event_analytics_succeeded: number; event_analytics_partial: number; event_analytics_stale: number; event_analytics_waiting: number; event_analytics_missing: number; event_analytics_failed: number; event_cohort_complete: number; event_cohort_partial: number; event_cohort_discovering: number; event_cohort_missing: number; team_snapshot_complete: number; team_snapshot_partial: number; team_snapshot_missing: number; team_snapshot_failed: number; event_resources_incomplete: number; team_resources_incomplete: number; read_errors: number };
};

function Panel({ children }: { children: ReactNode }) {
  return <section className="rounded-2xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4 sm:p-5">{children}</section>;
}
function time(value?: number | null) {
  return value == null ? "—" : new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  }).format(new Date(value));
}
function ago(value?: number | null) {
  if (value == null) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  return seconds < 60 ? seconds + "s ago" : seconds < 3600 ? Math.floor(seconds / 60) + "m ago"
    : seconds < 86400 ? Math.floor(seconds / 3600) + "h ago" : Math.floor(seconds / 86400) + "d ago";
}
function provider(endpoint: string) {
  if (endpoint.includes("statbotics") || endpoint.startsWith("/matches?") || endpoint.startsWith("/team_year") || endpoint.startsWith("/team_events?")) return "Statbotics";
  if (endpoint.includes("frc-colors")) return "FRC Colors";
  return "The Blue Alliance";
}
function endpointLabel(endpoint: string) {
  const url = new URL(endpoint, "https://fieldview.invalid");
  const name = url.pathname.split("/").filter(Boolean).slice(-1)[0] ?? "resource";
  return name.replaceAll("_", " ");
}
function endpointRows(state?: EntityState | null): Endpoint[] {
  const value = state?.endpoints;
  if (Array.isArray(value)) return value;
  return Object.entries(value ?? {}).map(([key, item]) => ({ ...item, endpoint: item.endpoint ?? key.replace(/^endpoint:/, "") }));
}
function statusTone(status?: string) {
  if (status === "available" || status === "succeeded" || status === "ok") return "text-emerald-600";
  if (status === "failed" || status === "unavailable" || status === "error") return "text-rose-600";
  if (status === "stale" || status === "partial" || status === "waiting-for-cohort" || status === "pending" || status === "unknown" || status === "running") return "text-amber-600";
  return "text-[var(--fv-muted)]";
}

export default function AdminOperationsDashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [kind, setKind] = useState<Kind>("event");
  const [query, setQuery] = useState("");
  const [year, setYear] = useState(0);
  const [yearInitialized, setYearInitialized] = useState(false);
  const [page, setPage] = useState<InventoryPage | null>(null);
  const [coverageAudit, setCoverageAudit] = useState<CoverageAudit | null>(null);
  const [seasonIngest, setSeasonIngest] = useState<SeasonIngest | null>(null);
  const [seasonPreview, setSeasonPreview] = useState<SeasonPreview | null>(null);
  const [cursor, setCursor] = useState(0);
  const [entity, setEntity] = useState<Entity | null>(null);
  const [eventTeamSeed, setEventTeamSeed] = useState<EventTeamSeed | null>(null);
  const [teamSeedJob, setTeamSeedJob] = useState<TeamSeedJob | null>(null);
  const [discoveryJob, setDiscoveryJob] = useState<DiscoveryJob | null>(null);
  const [selected, setSelected] = useState<{ kind: Kind; key: string; year: number } | null>(null);
  const [tab, setTab] = useState<"home" | "bootstrap" | "events" | "teams" | "system">("home");
  const [bootstrapMode, setBootstrapMode] = useState<"current" | "historical">("current");
  const [bootstrapYear, setBootstrapYear] = useState("");
  const [seedKind, setSeedKind] = useState<Kind>("event");
  const [seedKey, setSeedKey] = useState("");
  const [seedYear, setSeedYear] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const requestHeaders = useMemo(() => ({}), []);
  const refresh = useCallback(async (quiet = false) => {
    if (!authenticated) return;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/internal/admin/proxy", { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load operations overview");
      setOverview(body as Overview);
      if (!yearInitialized && typeof body.current_season?.year === "number" && Number.isInteger(body.current_season.year)) {
        setYear(body.current_season.year);
        setYearInitialized(true);
      }
      setAuthenticated(true); setError(""); setUpdatedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load runtime state");
      // Keep an authenticated operator in the panel when runtime health is degraded.
    } finally { if (!quiet) setLoading(false); }
  }, [authenticated, requestHeaders, yearInitialized]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void fetch("/internal/admin/proxy?auth=1", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({ error: "Invalid authentication response" }));
        if (!response.ok) throw new Error(body.error ?? "Cloudflare Access administrator authorization required");
        if (active) { setAuthenticated(true); setError(""); }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Cloudflare Access authentication failed");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const loadInventory = useCallback(async (nextCursor = 0) => {
    if (!authenticated) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ inventory: kind, q: query, cursor: String(nextCursor), limit: "50", year: String(year) });
      const response = await fetch("/internal/admin/proxy?" + params, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to search inventory");
      setPage(body as InventoryPage); setCursor(nextCursor); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Inventory search failed"); }
    finally { setLoading(false); }
  }, [authenticated, kind, query, year, requestHeaders]);

  const loadCoverageAudit = useCallback(async () => {
    if (!authenticated) return;
    try {
      const response = await fetch("/internal/admin/proxy?coverageAudit=" + year, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (response.ok) setCoverageAudit(body as CoverageAudit);
    } catch { /* Keep the last known audit result visible. */ }
  }, [authenticated, year, requestHeaders]);

  const loadSeasonIngest = useCallback(async () => {
    if (!authenticated) return;
    try {
      const response = await fetch("/internal/admin/proxy?seasonIngest=" + year, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (response.ok) setSeasonIngest(body as SeasonIngest);
    } catch { /* Preserve the last known durable job state. */ }
  }, [authenticated, year, requestHeaders]);

  const previewSeasonIngest = useCallback(async () => {
    if (!authenticated) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/internal/admin/proxy", {
        method: "POST", headers: { ...requestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "system", action: "season-ingest-preview", year }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to preview season ingestion");
      setSeasonPreview(body as SeasonPreview);
      if (body.existing_job) setSeasonIngest(body.existing_job as SeasonIngest);
      setMessage("Season inventory preview loaded. Review the counts before starting.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Season preview failed"); }
    finally { setBusy(false); }
  }, [authenticated, requestHeaders, year]);

  const controlSeasonIngest = useCallback(async (action: "start" | "pause" | "resume" | "cancel") => {
    if (!authenticated) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/internal/admin/proxy", {
        method: "POST", headers: { ...requestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "system", action: "season-ingest-" + action, year, ...(action === "start" ? { confirm: true } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Season-ingest operation failed");
      setSeasonIngest(body as SeasonIngest);
      setMessage(action === "start" ? "Season ingestion started and will continue through durable Workflow steps." : "Season ingestion " + action + " requested.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Season-ingest operation failed"); }
    finally { setBusy(false); }
  }, [authenticated, requestHeaders, year]);

  const runCoverageAudit = useCallback(async () => {
    if (!authenticated) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const action = coverageAudit?.year === year && (coverageAudit.status === "running" || coverageAudit.status === "paused") ? "coverage-audit-continue" : "coverage-audit-start";
      const response = await fetch("/internal/admin/proxy", {
        method: "POST", headers: { ...requestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "system", action, year }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Coverage audit failed");
      setCoverageAudit(body as CoverageAudit);
      setMessage("Coverage audit Workflow accepted. It will inspect the full season in durable batches while you continue using the dashboard.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Coverage audit failed"); }
    finally { setBusy(false); }
  }, [authenticated, requestHeaders, year, coverageAudit]);

  const openEntity = useCallback(async (entityKind: Kind, key: string, entityYear = year) => {
    setSelected({ kind: entityKind, key, year: entityYear });
    setEntity(null); setError(""); setMessage("");
    window.history.pushState(null, "", "/admin/runtime?" + entityKind + "=" + encodeURIComponent(key) + "&year=" + entityYear);
    try {
      const params = new URLSearchParams({ kind: entityKind, key, year: String(entityYear) });
      const response = await fetch("/internal/admin/proxy?" + params, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load command center");
      setEntity({ key, status: response.status, state: body as EntityState });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load entity state"); }
  }, [requestHeaders, year]);

  const loadEventTeamSeed = useCallback(async (eventKey: string, eventYear: number) => {
    if (!authenticated) return;
    try {
      const params = new URLSearchParams({ eventSeed: eventKey, year: String(eventYear) });
      const response = await fetch("/internal/admin/proxy?" + params, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (response.ok) setEventTeamSeed(body as EventTeamSeed);
    } catch { /* The next dashboard refresh will retry the status read. */ }
  }, [authenticated, requestHeaders]);

  const loadTeamSeedJob = useCallback(async (teamKey: string, teamYear: number) => {
    if (!authenticated) return;
    try {
      const params = new URLSearchParams({ teamSeed: teamKey, year: String(teamYear) });
      const response = await fetch("/internal/admin/proxy?" + params, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (response.ok) setTeamSeedJob(body as TeamSeedJob);
    } catch { /* Keep the most recent durable job state visible. */ }
  }, [authenticated, requestHeaders]);

  const loadDiscoveryJob = useCallback(async (targetYear = year) => {
    if (!authenticated) return;
    try {
      const params = new URLSearchParams({ discoveryJob: String(targetYear) });
      const response = await fetch("/internal/admin/proxy?" + params, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (response.ok) setDiscoveryJob(body as DiscoveryJob);
    } catch { /* Keep the most recent durable job state visible. */ }
  }, [authenticated, year, requestHeaders]);

  const runSeasonWorkflow = useCallback(async (workflowType: "event-readiness" | "team-readiness" | "season-status-resolver") => {
    setBusy(true); setMessage(""); setError("");
    try {
      if (workflowType !== "season-status-resolver" && (!Number.isInteger(year) || year < 1992 || year > 2200)) {
        throw new Error("Select a valid four-digit season year first.");
      }
      const response = await fetch("/internal/admin/proxy", {
        method: "POST", headers: { ...requestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ workflowType, ...(workflowType === "season-status-resolver" ? {} : { year }) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to start season workflow");
      setMessage(workflowType === "season-status-resolver"
        ? "Canonical season status resolution started."
        : (workflowType === "event-readiness" ? "Event" : "Team") + " readiness for " + year + " started. Refreshes will be dispatched through the queue.");
      void refresh(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start season workflow"); }
    finally { setBusy(false); }
  }, [year, requestHeaders, refresh]);

  const dispatch = useCallback(async (entityKind: Kind | "system", action: string, key?: string, endpoint?: string, operationYear?: number) => {
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch("/internal/admin/proxy", {
        method: "POST", headers: { ...requestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: entityKind, action, ...(key ? { key } : {}), ...(endpoint ? { endpoint } : {}), ...(operationYear ? { year: operationYear } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Operation failed");
      if (entityKind === "event" && action === "seed-event-teams") setEventTeamSeed(body as EventTeamSeed);
      if (entityKind === "team" && action === "seed" && key) setTeamSeedJob(body as TeamSeedJob);
      if (entityKind === "system" && action === "discover-year") setDiscoveryJob(body as DiscoveryJob);
      void refresh(true);
      if (entityKind !== "system" && key) void openEntity(entityKind, key, operationYear ?? selected?.year ?? year);
      const label = action.replaceAll("-", " ");
      setMessage(action === "discover-year"
        ? label + " accepted. The discovery Workflow will publish the selected season's directories."
        : ["refresh", "resource-refresh", "statbotics-refresh", "seed", "season-analytics-refresh"].includes(action)
          ? label + " completed. The runtime fetched and reconciled its own resources."
          : ["recalculate", "seed-event-teams"].includes(action)
            ? label + " accepted. The owning runtime or Workflow will publish the result asynchronously."
            : label + " accepted.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Operation failed"); }
    finally { setBusy(false); }
  }, [requestHeaders, refresh, openEntity, selected, year]);

  // Keep the selected runtime view current after direct commands and asynchronous jobs.
  // This is a single-object read, not a fan-out across the runtime inventory.
  useEffect(() => {
    if (!authenticated || !selected) return;
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const params = new URLSearchParams({ kind: selected.kind, key: selected.key, year: String(selected.year) });
        const response = await fetch("/internal/admin/proxy?" + params, { headers: requestHeaders, cache: "no-store" });
        const body = await response.json();
        if (active && response.ok) setEntity({ key: selected.key, status: response.status, state: body as EntityState });
      } catch {
        // Keep the last good runtime state visible during a transient read failure.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [authenticated, selected?.kind, selected?.key, selected?.year, requestHeaders]);

  useEffect(() => {
    if (!authenticated || selected?.kind !== "team") { setTeamSeedJob(null); return; }
    void loadTeamSeedJob(selected.key, selected.year);
  }, [authenticated, selected?.kind, selected?.key, selected?.year, loadTeamSeedJob]);

  useEffect(() => {
    if (!authenticated || selected?.kind !== "team" || teamSeedJob?.status !== "running") return;
    const timer = window.setInterval(() => void loadTeamSeedJob(selected.key, selected.year), 3_000);
    return () => window.clearInterval(timer);
  }, [authenticated, selected?.kind, selected?.key, selected?.year, teamSeedJob?.status, loadTeamSeedJob]);

  useEffect(() => {
    if (!authenticated) return;
    void loadDiscoveryJob();
  }, [authenticated, loadDiscoveryJob]);

  useEffect(() => {
    if (!authenticated || discoveryJob?.status !== "running") return;
    const timer = window.setInterval(() => void loadDiscoveryJob(discoveryJob.year), 3_000);
    return () => window.clearInterval(timer);
  }, [authenticated, discoveryJob?.status, discoveryJob?.mode, discoveryJob?.year, loadDiscoveryJob]);

  useEffect(() => {
    if (!authenticated || selected?.kind !== "event") { setEventTeamSeed(null); return; }
    void loadEventTeamSeed(selected.key, selected.year);
  }, [authenticated, selected?.kind, selected?.key, selected?.year, loadEventTeamSeed]);

  useEffect(() => {
    if (!authenticated || selected?.kind !== "event" || eventTeamSeed?.status !== "running") return;
    const timer = window.setInterval(() => void loadEventTeamSeed(selected.key, selected.year), 3_000);
    return () => window.clearInterval(timer);
  }, [authenticated, selected?.kind, selected?.key, selected?.year, eventTeamSeed?.status, loadEventTeamSeed]);

  useEffect(() => {
    if (!authenticated || selected) return;
    const timer = window.setInterval(() => void refresh(true), 60_000);
    return () => window.clearInterval(timer);
  }, [authenticated, refresh, selected]);

  useEffect(() => {
    if (!authenticated) return;
    void loadCoverageAudit();
  }, [authenticated, loadCoverageAudit]);

  useEffect(() => {
    if (!authenticated) return;
    void loadSeasonIngest();
    setSeasonPreview(null);
  }, [authenticated, loadSeasonIngest]);

  useEffect(() => {
    if (!authenticated || seasonIngest?.status !== "running") return;
    const timer = window.setInterval(() => void loadSeasonIngest(), 10_000);
    return () => window.clearInterval(timer);
  }, [authenticated, seasonIngest?.status, loadSeasonIngest]);

  // A running audit is durable, but advancing it is an explicit operator action.
  // Poll only its read-only status; never start another batch automatically.
  useEffect(() => {
    if (!authenticated || coverageAudit?.status !== "running") return;
    const timer = window.setInterval(() => void loadCoverageAudit(), 5_000);
    return () => window.clearInterval(timer);
  }, [authenticated, coverageAudit?.year, coverageAudit?.status, loadCoverageAudit]);

  useEffect(() => {
    if (!authenticated || (tab !== "events" && tab !== "teams")) return;
    const timer = window.setTimeout(() => void loadInventory(0), 250);
    return () => window.clearTimeout(timer);
  }, [authenticated, tab, kind, query, loadInventory]);

  useEffect(() => {
    if (!authenticated || selected) return;
    const params = new URLSearchParams(window.location.search);
    const eventKey = params.get("event"), teamKey = params.get("team");
    const selectedYear = Number(params.get("year") ?? year);
    if (eventKey) { setYear(selectedYear); void openEntity("event", eventKey, selectedYear); }
    else if (teamKey) { setYear(selectedYear); void openEntity("team", teamKey, selectedYear); }
  }, [authenticated, selected, openEntity, year]);

  useEffect(() => {
    const handlePop = () => {
      const params = new URLSearchParams(window.location.search);
      const eventKey = params.get("event"), teamKey = params.get("team");
      const selectedYear = Number(params.get("year") ?? year);
      if (eventKey) { setYear(selectedYear); void openEntity("event", eventKey, selectedYear); }
      else if (teamKey) { setYear(selectedYear); void openEntity("team", teamKey, selectedYear); }
      else setSelected(null);
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [openEntity, year]);

  const resources = endpointRows(entity?.state);
  const tasks = entity?.state?.polling ?? [];
  const isEvent = selected?.kind === "event";

  if (!authenticated) return <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-12">
    <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FieldView operations</p>
    <h1 className="mt-1 text-3xl font-bold">Command center</h1>
    <p className="mt-2 text-sm text-[var(--fv-muted)]">Checking your Cloudflare Access administrator session…</p>
    {error && <p role="alert" className="mt-4 text-sm text-rose-600">{error}</p>}
    <button onClick={() => window.location.reload()} className="mt-5 w-full rounded-xl border border-[var(--fv-border)] px-4 py-3 text-sm font-semibold">Retry authentication</button>
  </main>;

  return <main className="mx-auto min-h-dvh w-full max-w-[1500px] px-4 py-7 sm:px-6 lg:px-8">
    {(error || message) && <div role={error ? "alert" : "status"} className={"sticky top-0 z-50 mb-4 rounded-xl border bg-white px-4 py-3 text-sm shadow-md " + (error ? "border-rose-300 text-rose-700" : "border-[var(--fv-border)] text-[var(--fv-text)]")}>{error || message}</div>}
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FieldView operations</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Command center</h1><p className="mt-1 text-sm text-[var(--fv-muted)]">A focused view of runtime health, canonical data coverage, and ingestion work.</p></div>
      <div className="flex items-center gap-2"><span className="text-xs text-[var(--fv-muted)]">Updated {ago(updatedAt)}</span><button onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold">Refresh</button></div>
    </header>
    <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-[var(--fv-border)]" aria-label="Operations sections">
      {(["home", "bootstrap", "events", "teams", "system"] as const).map((item) => <button key={item} onClick={() => { setTab(item); if (item === "events" || item === "teams") setKind(item === "events" ? "event" : "team"); setSelected(null); setEntity(null); setQuery(""); window.history.pushState(null, "", "/admin/runtime"); }} className={"shrink-0 border-b-2 px-4 py-3 text-sm font-semibold capitalize " + (tab === item ? "border-[var(--fv-brand)] text-[var(--fv-text)]" : "border-transparent text-[var(--fv-muted)]")}>{item === "home" ? "Overview" : item === "bootstrap" ? "Bootstrap" : item}</button>)}
    </nav>

    {tab === "home" && <div className="mt-6 space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[["Registered events", overview?.inventory?.events ?? "—"], ["Registered teams", overview?.inventory?.teams ?? "—"], ["Current season", overview?.current_season?.year ?? "—"], ["Multiplexer clients", overview?.multiplexer?.clients ?? "—"]].map(([label, value]) => <Panel key={String(label)}><p className="text-xs text-[var(--fv-muted)]">{label}</p><p className="mt-1 text-2xl font-bold tabular-nums">{value}</p></Panel>)}
      </div>
      <p className="rounded-xl border border-[var(--fv-border)] px-4 py-3 text-xs leading-5 text-[var(--fv-muted)]">Overview reads the published current-season index and runtime inventory metadata only. It does not probe every EventRuntime and TeamRuntime; open an event or team below to inspect its live state and provider resources.</p>
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-bold">Full-season canonical ingestion</h2><p className="mt-1 max-w-3xl text-xs text-[var(--fv-muted)]">Prepares every TeamRuntime season snapshot first, then generates EventState and EventAnalytics for every discovered event. Work is sequential, durable, resumable, and separate from the live discovery scheduler. It does not use team seed fan-out.</p></div>
          <button disabled={busy} onClick={() => void previewSeasonIngest()} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-xs font-semibold disabled:opacity-40">Preview {year} inventory</button>
        </div>
        {seasonPreview && <div className="mt-3 rounded-lg border border-[var(--fv-border)] p-3 text-sm">
          <p className="font-semibold">{seasonPreview.ready ? "Ready to start" : seasonPreview.runtime_ready === false ? "Runtime configuration is incomplete" : "Discovery is incomplete"}</p>
          {seasonPreview.ready_reason && <p className="mt-1 text-xs text-amber-600">{seasonPreview.ready_reason}</p>}
          <p className="mt-1 text-xs text-[var(--fv-muted)]">{seasonPreview.events.toLocaleString()} events · {seasonPreview.teams.toLocaleString()} teams · {seasonPreview.team_pages} TBA team pages</p>
          <p className="mt-1 text-xs text-[var(--fv-muted)]">{seasonPreview.event_resources_per_event} event resources/event · {seasonPreview.team_resources_per_team} team resources/team · {(seasonPreview.planned_resource_requests ?? 0).toLocaleString()} planned resource requests</p>
          <p className="mt-1 text-xs text-[var(--fv-muted)]">Shared provider interval: {seasonPreview.request_interval_ms ?? 1000} ms · Baseline duration: {((seasonPreview.estimated_minimum_duration_ms ?? 0) / 3_600_000).toFixed(1)} hours</p>
          {seasonPreview.estimate_note && <p className="mt-1 text-xs text-[var(--fv-muted)]">{seasonPreview.estimate_note}</p>}
          {seasonPreview.ready && <p className="mt-2 text-xs text-[var(--fv-muted)]">Starting confirms that FieldView may make provider requests for this full inventory. One shared lease serializes EventRuntime and TeamRuntime provider calls; cached resources are skipped.</p>}
        </div>}
        {seasonIngest && typeof seasonIngest.status === "string" && seasonIngest.status !== "not_started" && <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-semibold capitalize">{seasonIngest.status.replaceAll("_", " ")} · {seasonIngest.phase ?? "—"} phase</span><span>Teams {seasonIngest.team_cursor ?? 0}/{seasonIngest.team_total ?? 0} (resource {seasonIngest.team_resource_cursor ?? 0}/{seasonIngest.team_resources_per_team ?? 7}) · Events {seasonIngest.event_cursor ?? 0}/{seasonIngest.event_total ?? 0} (resource {seasonIngest.event_resource_cursor ?? 0}/{seasonIngest.event_resources_per_event ?? 13})</span></div>
          <p className="text-[10px] text-[var(--fv-muted)]">Season TeamRuntime snapshot revision: {seasonIngest.team_snapshot_revision ?? 0}</p>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--fv-border)]"><div className="h-full bg-[var(--fv-brand)]" style={{ width: (((seasonIngest.team_cursor ?? 0) * (seasonIngest.team_resources_per_team ?? 7) + (seasonIngest.team_resource_cursor ?? 0) + (seasonIngest.event_cursor ?? 0) * (seasonIngest.event_resources_per_event ?? 13) + (seasonIngest.event_resource_cursor ?? 0)) / Math.max(1, (seasonIngest.team_total ?? 0) * (seasonIngest.team_resources_per_team ?? 7) + (seasonIngest.event_total ?? 0) * (seasonIngest.event_resources_per_event ?? 13))) * 100 + "%" }} /></div>
          {seasonIngest.counts && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            {[
              ["Teams complete", seasonIngest.counts.teams_complete], ["Teams partial", seasonIngest.counts.teams_partial], ["Teams failed", seasonIngest.counts.teams_failed],
              ["EventState complete", seasonIngest.counts.event_state_complete], ["EventState partial", seasonIngest.counts.event_state_partial], ["EventState failed", seasonIngest.counts.event_state_failed], ["EventState missing", seasonIngest.counts.event_state_missing],
              ["EventAnalytics succeeded", seasonIngest.counts.event_analytics_succeeded], ["EventAnalytics partial", seasonIngest.counts.event_analytics_partial],
              ["Waiting for cohort", seasonIngest.counts.event_analytics_waiting], ["EventAnalytics missing", seasonIngest.counts.event_analytics_missing], ["EventAnalytics failed", seasonIngest.counts.event_analytics_failed], ["Cohort complete", seasonIngest.counts.event_cohort_complete], ["Cohort partial", seasonIngest.counts.event_cohort_partial], ["Cohort discovering", seasonIngest.counts.event_cohort_discovering], ["Cohort missing", seasonIngest.counts.event_cohort_missing],
              ["Requests attempted", seasonIngest.counts.requests_attempted], ["Requests succeeded", seasonIngest.counts.requests_succeeded],
              ["Requests failed", seasonIngest.counts.requests_failed], ["Requests retried", seasonIngest.counts.requests_retried], ["Requests skipped", seasonIngest.counts.requests_skipped],
              ["Resources unavailable", seasonIngest.counts.requests_unavailable], ["Requests deferred by gate", seasonIngest.counts.requests_deferred],
            ].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-[var(--fv-border)] p-2"><p className="text-[var(--fv-muted)]">{label}</p><p className="mt-1 text-lg font-bold tabular-nums">{value}</p></div>)}
          </div>}
          {seasonIngest.recent_errors && seasonIngest.recent_errors.length > 0 && <details className="text-xs"><summary className="cursor-pointer font-semibold">Recent ingestion errors ({seasonIngest.recent_errors.length})</summary><ul className="mt-2 space-y-1">{seasonIngest.recent_errors.slice(-10).map((item, index) => <li key={item.kind + item.key + index} className="text-rose-600">{item.kind} {item.key}: {item.detail}</li>)}</ul></details>}
        </div>}
        <div className="mt-3 flex flex-wrap gap-2">
          {!seasonIngest || seasonIngest.status === "not_started" || seasonIngest.status === "completed" || seasonIngest.status === "cancelled"
            ? <button disabled={busy || !seasonPreview?.ready} onClick={() => void controlSeasonIngest("start")} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Start full-season ingestion</button>
            : null}
          {seasonIngest?.status === "running" && <button disabled={busy} onClick={() => void controlSeasonIngest("pause")} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-xs font-semibold disabled:opacity-40">Pause</button>}
          {(seasonIngest?.status === "paused" || seasonIngest?.status === "completed_with_errors") && <button disabled={busy} onClick={() => void controlSeasonIngest("resume")} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Resume / retry</button>}
          {(seasonIngest?.status === "running" || seasonIngest?.status === "paused" || seasonIngest?.status === "completed_with_errors") && <button disabled={busy} onClick={() => void controlSeasonIngest("cancel")} className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-semibold text-rose-600 disabled:opacity-40">Cancel</button>}
        </div>
      </Panel>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><h2 className="font-bold">Data coverage</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">The overview stays lightweight and does not inspect every runtime. Use the full-season audit below for comprehensive coverage; each batch is started explicitly.</p></div>
          <span className="text-xs text-[var(--fv-muted)]">Season {year}</span>
        </div>
        <div className="mt-4 border-t border-[var(--fv-border)] pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="text-sm font-bold">Full-season coverage audit</h3><p className="mt-1 text-xs text-[var(--fv-muted)]">Reads every event and every team in the selected season's completed TBA discovery snapshots. Team discovery walks all 500-team pages; this audit makes no provider API requests and processes up to 5 runtime reads per background batch.</p></div>
            <div className="flex flex-wrap items-center gap-2"><label className="text-xs text-[var(--fv-muted)]">Year <input aria-label="Coverage audit year" type="number" min="1992" max="2200" value={year} onChange={(event) => { setYear(Number(event.target.value)); setYearInitialized(true); }} className="ml-1 w-20 rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-2 py-2 text-sm text-[var(--fv-text)]" /></label>{coverageAudit?.year === year && coverageAudit.discovery_ready === false ? <button disabled={busy} onClick={async () => { await dispatch("system", "discover-year", undefined, undefined, year); await loadCoverageAudit(); }} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Discover {year} season</button> : <button disabled={busy || !coverageAudit?.discovery_ready || coverageAudit?.status === "running"} onClick={() => void runCoverageAudit()} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{coverageAudit?.year === year && coverageAudit.status === "running" ? "Audit running…" : coverageAudit?.year === year && coverageAudit.status === "paused" ? "Resume audit" : coverageAudit?.year === year && coverageAudit.status === "completed" ? "Run audit again" : "Start full audit"}</button>}</div>
          </div>
          {coverageAudit && coverageAudit.year === year && <div className="mt-3 space-y-2">
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="font-semibold capitalize">{coverageAudit.status.replaceAll("_", " ")}</span><span>{coverageAudit.processed ?? coverageAudit.cursor ?? 0} / {coverageAudit.total ?? ((coverageAudit.counts?.events_total ?? 0) + (coverageAudit.counts?.teams_total ?? 0))} runtimes inspected</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--fv-border)]"><div className="h-full rounded-full bg-[var(--fv-brand)]" style={{ width: ((coverageAudit.processed ?? coverageAudit.cursor ?? 0) / Math.max(1, coverageAudit.total ?? ((coverageAudit.counts?.events_total ?? 0) + (coverageAudit.counts?.teams_total ?? 0)))) * 100 + "%" }} /></div>
            {coverageAudit.counts && <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {[["Events listed by TBA", coverageAudit.counts.events_total], ["Events already held", coverageAudit.counts.events_happened], ["Events in progress", coverageAudit.counts.events_active], ["Upcoming events", coverageAudit.counts.events_upcoming], ["Events with invalid dates/timezones", coverageAudit.counts.events_invalid_dates], ["Teams in complete TBA season inventory", coverageAudit.counts.teams_total], ["TBA team pages", coverageAudit.counts.team_pages], ["Events with complete EventState", coverageAudit.counts.event_state_complete], ["Events with partial EventState", coverageAudit.counts.event_state_partial], ["Events with stale EventState", coverageAudit.counts.event_state_stale], ["Events missing EventState", coverageAudit.counts.event_state_missing], ["Events with failed EventState", coverageAudit.counts.event_state_failed], ["Events with successful EventAnalytics", coverageAudit.counts.event_analytics_succeeded], ["Events with partial EventAnalytics", coverageAudit.counts.event_analytics_partial], ["Events with stale EventAnalytics", coverageAudit.counts.event_analytics_stale], ["Events waiting for cohort", coverageAudit.counts.event_analytics_waiting], ["Events missing EventAnalytics", coverageAudit.counts.event_analytics_missing], ["Events with failed EventAnalytics", coverageAudit.counts.event_analytics_failed], ["Complete participant cohorts", coverageAudit.counts.event_cohort_complete], ["Partial participant cohorts", coverageAudit.counts.event_cohort_partial], ["Participant cohorts discovering", coverageAudit.counts.event_cohort_discovering], ["Participant cohorts missing", coverageAudit.counts.event_cohort_missing], ["Teams with complete season snapshots", coverageAudit.counts.team_snapshot_complete], ["Teams with partial season snapshots", coverageAudit.counts.team_snapshot_partial], ["Teams with missing runtimes", coverageAudit.counts.team_snapshot_missing], ["Teams with failed season snapshots", coverageAudit.counts.team_snapshot_failed], ["Events with incomplete resources", coverageAudit.counts.event_resources_incomplete], ["Teams with incomplete resources", coverageAudit.counts.team_resources_incomplete], ["Events without registered runtimes", coverageAudit.counts.event_runtime_missing], ["Teams without registered runtimes", coverageAudit.counts.team_runtime_missing], ["Read errors", coverageAudit.counts.read_errors]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-[var(--fv-border)] p-2"><p className="text-[10px] text-[var(--fv-muted)]">{label}</p><p className="text-lg font-bold tabular-nums">{value}</p></div>)}
            </div>}
            {coverageAudit.status === "stale" && <p className="text-xs text-amber-600">This audit was created from an older or incomplete discovery snapshot. Discover all team pages and rerun the audit before relying on these counts.</p>}
            {coverageAudit.status === "running" && <p className="text-xs text-[var(--fv-muted)]">The Workflow is processing the full inventory in durable batches. Progress updates automatically; you can leave this page and return later.</p>}
            {coverageAudit.status === "completed" && <p className="text-xs text-emerald-600">Full inventory audit completed for {year}. Counts cover the discovered season snapshot, not just the dashboard sample.</p>}
          </div>}
          {(!coverageAudit || coverageAudit.year !== year) && <p className="mt-3 text-xs text-[var(--fv-muted)]">No complete audit exists for {year}. First retrieve the full TBA event list and every 500-team page; the audit will remain unavailable until paginated team discovery is complete.</p>}
        </div>
      </Panel>
      <Panel><h2 className="font-bold">Current-season discovery Workflow</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">TBA /status selects the season. The scheduled Workflow publishes the event and team directories, initializes upcoming/active/recently completed EventRuntime instances, and seeds participants for this week’s events.</p><div className="mt-3 grid gap-3 text-sm sm:grid-cols-3"><div><p className="text-xs text-[var(--fv-muted)]">Directory status</p><strong className={statusTone(overview?.current_season?.status)}>{overview?.current_season?.status ?? "Unavailable"}</strong></div><div><p className="text-xs text-[var(--fv-muted)]">Discovered events</p>{overview?.current_season?.event_count ?? "—"}</div><div><p className="text-xs text-[var(--fv-muted)]">Last directory update</p>{time(overview?.current_season?.updated_at)}</div></div></Panel>
    </div>}

    {tab === "bootstrap" && !selected && <section className="mt-6 space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--fv-brand)]">Empty-state setup</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">Bring FieldView online</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fv-muted)]">Initialize directory metadata first, then populate canonical runtime state. These are explicit operator actions; opening this page never starts provider ingestion.</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,.8fr)]">
        <Panel>
          <div className="flex items-start justify-between gap-3">
            <div><h3 className="text-lg font-bold">1. Discover season directories</h3><p className="mt-1 text-xs leading-5 text-[var(--fv-muted)]">Retrieves TBA /status, persists its authoritative current_season pointer, discovers the selected year's event directory and all paginated team pages, and registers runtime identities. It does not fully populate EventState, TeamState, or analytics.</p></div>
            <span className="rounded-full bg-[var(--fv-brand-soft)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--fv-brand-strong)]">Required first</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Season discovery mode">
            <button type="button" onClick={() => setBootstrapMode("current")} className={"rounded-lg px-3 py-2 text-xs font-semibold " + (bootstrapMode === "current" ? "bg-[var(--fv-brand)] text-white" : "border border-[var(--fv-border)]")}>Current season</button>
            <button type="button" onClick={() => setBootstrapMode("historical")} className={"rounded-lg px-3 py-2 text-xs font-semibold " + (bootstrapMode === "historical" ? "bg-[var(--fv-brand)] text-white" : "border border-[var(--fv-border)]")}>Historical season</button>
          </div>
          {bootstrapMode === "current" ? <div className="mt-4 rounded-xl border border-[var(--fv-border)] p-3">
            <p className="text-xs font-semibold">Canonical current season</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{overview?.current_season?.year ?? "Not initialized"}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--fv-muted)]">{overview?.current_season?.status === "available" ? "The persisted pointer is available. Discovery will refresh it from TBA before rebuilding the directory." : "The pointer is empty or unavailable. Enter the expected year for the first directory pass; the workflow independently resolves and persists TBA's current_season."}</p>
            {overview?.current_season?.year == null && <label className="mt-3 block text-xs font-semibold">Expected TBA current season
              <input type="number" min="1992" max="2200" value={bootstrapYear} onChange={(event) => setBootstrapYear(event.target.value)} placeholder="e.g. 2027" className="mt-1 block w-full max-w-xs rounded-lg border border-[var(--fv-border)] bg-white px-3 py-2 text-sm font-normal" />
            </label>}
          </div> : <div className="mt-4 rounded-xl border border-[var(--fv-border)] p-3">
            <p className="text-xs font-semibold">Historical directory year</p>
            <label className="mt-2 block text-xs text-[var(--fv-muted)]">Season year
              <input type="number" min="1992" max="2200" value={bootstrapYear} onChange={(event) => setBootstrapYear(event.target.value)} placeholder="e.g. 2024" className="mt-1 block w-full max-w-xs rounded-lg border border-[var(--fv-border)] bg-white px-3 py-2 text-sm text-[var(--fv-text)]" />
            </label>
            <p className="mt-2 text-xs leading-5 text-[var(--fv-muted)]">Historical discovery writes that year's directory only. TBA /status is still checked to maintain the separate canonical current-season pointer; the historical year never replaces it.</p>
          </div>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button disabled={busy || !(bootstrapMode === "current" ? (overview?.current_season?.year ?? Number(bootstrapYear)) : Number(bootstrapYear))} onClick={() => {
              const targetYear = bootstrapMode === "current" ? (overview?.current_season?.year ?? Number(bootstrapYear)) : Number(bootstrapYear);
              if (!Number.isInteger(targetYear) || targetYear < 1992 || targetYear > 2200) { setError("Enter a valid season year."); return; }
              void dispatch("system", "discover-year", undefined, undefined, targetYear);
            }} className="rounded-lg bg-[var(--fv-brand)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Starting…" : bootstrapMode === "current" ? "Resolve current season & discover" : "Discover historical season"}</button>
            <span className="text-xs text-[var(--fv-muted)]">Existing discovery job: {discoveryJob?.status ?? "not started"}</span>
          </div>
          {discoveryJob && discoveryJob.status !== "not_started" && <div className="mt-4 rounded-xl border border-[var(--fv-border)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">Discovery progress · {discoveryJob.year}</strong><span className={"text-xs font-bold " + statusTone(discoveryJob.status === "completed" ? "succeeded" : discoveryJob.status === "failed" ? "failed" : "running")}>{discoveryJob.status.replaceAll("_", " ")}</span></div>
            <p className="mt-2 text-xs text-[var(--fv-muted)]">Stage: {discoveryJob.stage ?? "queued"} · {discoveryJob.events ?? 0} events · {discoveryJob.teams ?? 0} teams · {discoveryJob.steps ?? 0} workflow steps</p>
            {discoveryJob.error && <p className="mt-2 text-xs text-rose-600">{discoveryJob.error}</p>}
          </div>}
        </Panel>
        <Panel>
          <h3 className="text-lg font-bold">2. Populate canonical data</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--fv-muted)]">Directory discovery creates the inventory and registers runtime identities. Full-season ingestion then seeds TeamRuntime snapshots, acquires event resources, publishes EventState, and calculates EventAnalytics.</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-[var(--fv-surface)] p-3"><p className="text-[10px] uppercase tracking-wide text-[var(--fv-muted)]">Events discovered</p><p className="mt-1 text-2xl font-bold">{overview?.current_season?.event_count ?? (seasonPreview?.events ?? "—")}</p></div>
            <div className="rounded-xl bg-[var(--fv-surface)] p-3"><p className="text-[10px] uppercase tracking-wide text-[var(--fv-muted)]">Teams registered</p><p className="mt-1 text-2xl font-bold">{overview?.inventory?.teams ?? "—"}</p></div>
          </div>
          <p className="mt-3 text-xs text-[var(--fv-muted)]">Selected ingestion season: <strong>{year || "not selected"}</strong></p>
          <button disabled={busy || !year} onClick={() => { setTab("home"); void previewSeasonIngest(); }} className="mt-4 rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold disabled:opacity-40">Preview canonical ingestion</button>
          {seasonIngest && <p className="mt-3 text-xs text-[var(--fv-muted)]">Ingestion status: <strong>{seasonIngest.status.replaceAll("_", " ")}</strong> · {seasonIngest.phase ?? "—"}</p>}
        </Panel>
      </div>
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold">Seed one entity by TBA key</h3><p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--fv-muted)]">Use this for targeted initialization without running a full-season ingestion. Event keys look like 2026mmr; team keys look like frc10063. Team seeding also registers the team's event history for the selected season.</p></div><span className="text-xs text-[var(--fv-muted)]">Independent of season-wide ingestion</span></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[160px_minmax(180px,1fr)_130px_auto] sm:items-end">
          <label className="text-xs font-semibold">Entity type
            <select value={seedKind} onChange={(event) => setSeedKind(event.target.value as Kind)} className="mt-1 block w-full rounded-lg border border-[var(--fv-border)] bg-white px-3 py-2.5 text-sm font-normal"><option value="event">Event</option><option value="team">Team</option></select>
          </label>
          <label className="text-xs font-semibold">TBA key
            <input value={seedKey} onChange={(event) => setSeedKey(event.target.value.trim())} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); document.getElementById("fieldview-seed-entity")?.click(); } }} placeholder={seedKind === "event" ? "2026mmr" : "frc10063"} className="mt-1 block w-full rounded-lg border border-[var(--fv-border)] bg-white px-3 py-2.5 text-sm font-normal" />
          </label>
          <label className="text-xs font-semibold">Season context
            <input type="number" min="1992" max="2200" value={seedYear || year || ""} onChange={(event) => setSeedYear(event.target.value)} className="mt-1 block w-full rounded-lg border border-[var(--fv-border)] bg-white px-3 py-2.5 text-sm font-normal" />
          </label>
          <button id="fieldview-seed-entity" disabled={busy || !seedKey || !(Number(seedYear || year || (seedKind === "event" ? seedKey.slice(0, 4) : 0)) >= 1992)} onClick={() => {
            const key = seedKey.trim();
            const targetYear = Number(seedYear || year || (seedKind === "event" ? key.slice(0, 4) : 0));
            if (seedKind === "event" && !/^\d{4}[a-zA-Z0-9_-]+$/.test(key)) { setError("Enter an event key such as 2026mmr."); return; }
            if (seedKind === "team" && !/^frc\d+$/.test(key)) { setError("Enter a team key such as frc10063."); return; }
            if (!Number.isInteger(targetYear) || targetYear < 1992 || targetYear > 2200) { setError("Select a valid season context."); return; }
            if (seedKind === "event" && Number(key.slice(0, 4)) !== targetYear) { setError("The event key year must match the selected season context."); return; }
            void dispatch(seedKind, seedKind === "event" ? "refresh" : "seed", key, undefined, targetYear);
            setSeedKey("");
          }} className="rounded-lg bg-[var(--fv-brand)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">Seed entity</button>
        </div>
        <p className="mt-3 text-[11px] leading-5 text-[var(--fv-muted)]">Event seeding initializes its EventRuntime and acquires its configured event resources. Team seeding runs the durable team-seed Workflow and registers historical event identities found in that team's selected-season history. Neither action starts a season-wide ingest.</p>
      </Panel>
    </section>}

    {(tab === "events" || tab === "teams") && !selected && <section className="mt-6 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-bold">{tab === "events" ? "Event directory" : "Team directory"}</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">Search the full registered inventory and open an individual command center.</p></div><div className="flex flex-wrap gap-2"><label className="flex items-center gap-2 text-xs text-[var(--fv-muted)]">Season <input aria-label="Inventory season year" type="number" min="1992" max="2200" value={year || ""} onChange={(event) => { setYear(Number(event.target.value)); setYearInitialized(true); }} className="w-24 rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-2 py-2 text-sm text-[var(--fv-text)]" /></label><input aria-label="Search inventory" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "events" ? "Search event key…" : "Search team key…"} className="w-64 rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-3 py-2 text-sm" /><button disabled={!year} onClick={() => void loadInventory(0)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-50">Search</button></div></div>
      <Panel><div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold">{page?.total ?? 0} matching registered {kind}s</p><p className="text-xs text-[var(--fv-muted)]">Season {year} · 50 per page</p></div>{page && !page.discovery_ready && <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 px-3 py-2"><p className="text-xs text-amber-700">No {year} discovery snapshot is cached yet. Results include only previously registered runtime objects.</p><button disabled={busy} onClick={async () => { await dispatch("system", "discover-year", undefined, undefined, year); await loadInventory(0); }} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Discover {year} season</button></div>}<div className="mt-3 divide-y divide-[var(--fv-border)]">{(page?.keys ?? []).map((key) => {
        return <button key={key} onClick={() => void openEntity(kind, key, year)} className="flex w-full flex-wrap items-center justify-between gap-3 py-3 text-left hover:bg-[var(--fv-brand-soft)]/30"><span><strong className="text-sm">{key}</strong><span className="ml-3 text-xs text-[var(--fv-muted)]">Open live {kind} state and provider health</span></span><span className="text-xs text-[var(--fv-brand)]">Inspect →</span></button>;
      })}{!page?.keys.length && <p className="py-8 text-center text-sm text-[var(--fv-muted)]">No registered objects match this search.</p>}</div><div className="mt-3 flex items-center justify-between"><button disabled={cursor === 0 || loading} onClick={() => void loadInventory(Math.max(0, cursor - 50))} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-xs disabled:opacity-40">Previous</button><span className="text-xs text-[var(--fv-muted)]">{page ? page.cursor + 1 : 0}–{Math.min((page?.cursor ?? 0) + 50, page?.total ?? 0)} of {page?.total ?? 0}</span><button disabled={page?.next_cursor == null || loading} onClick={() => void loadInventory(page?.next_cursor ?? 0)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-xs disabled:opacity-40">Next</button></div></Panel>
    </section>}

    {selected && <section className="mt-6 space-y-4">
      <button onClick={() => { setSelected(null); setEntity(null); window.history.pushState(null, "", "/admin/runtime"); }} className="text-sm font-semibold text-[var(--fv-brand)]">← Back to {selected.kind} directory</button>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-[var(--fv-brand)]">{selected.kind} command center</p><h2 className="mt-1 text-2xl font-bold">{selected.key}</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">{resources.length} provider resources · {tasks.length} legacy task records · live state refreshes every 5 seconds</p></div><div className="flex flex-wrap gap-2">{isEvent ? <><button disabled={busy} onClick={() => void dispatch("event", "refresh", selected.key)} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Refreshing…" : "Refresh event"}</button><button disabled={busy || eventTeamSeed?.status === "running"} onClick={() => void dispatch("event", "seed-event-teams", selected.key, undefined, selected.year)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">{eventTeamSeed?.status === "running" ? "Seeding event teams…" : "Seed all event teams"}</button><button disabled={busy} onClick={() => void dispatch("event", "statbotics-refresh", selected.key)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">{busy ? "Refreshing…" : "Refresh Statbotics"}</button><button disabled={busy} onClick={() => void dispatch("event", "recalculate", selected.key)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">{busy ? "Recalculating…" : "Recalculate analytics"}</button></> : <><button disabled={busy} onClick={() => void dispatch("team", "refresh", selected.key, undefined, selected.year)} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Refreshing…" : "Refresh team"}</button><button disabled={busy} onClick={() => void dispatch("team", "seed", selected.key, undefined, selected.year)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">{busy ? "Seeding…" : "Seed team + events"}</button><button disabled={busy} onClick={() => void dispatch("team", "season-analytics-refresh", selected.key, undefined, selected.year)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">{busy ? "Recalculating…" : "Recalculate season analytics"}</button></>}</div></div>
      {!entity && <Panel><p className="text-sm text-[var(--fv-muted)]">Loading entity state…</p></Panel>}
      {entity && <><div className="grid gap-3 sm:grid-cols-3"><Panel><p className="text-xs text-[var(--fv-muted)]">Provider resources</p><p className="mt-1 text-2xl font-bold">{resources.length}</p></Panel><Panel><p className="text-xs text-[var(--fv-muted)]">Legacy tasks</p><p className="mt-1 text-2xl font-bold">{tasks.length}</p></Panel><Panel><p className="text-xs text-[var(--fv-muted)]">{isEvent ? "Analytics status" : "Team runtime"}</p><p className={"mt-1 text-lg font-bold " + statusTone(isEvent ? entity.state?.analytics?.status : entity.status === 200 ? "available" : "failed")}>{isEvent ? entity.state?.analytics?.status ?? "not calculated" : entity.status === 200 ? "reachable" : "unavailable"}</p></Panel></div>
      {!isEvent && teamSeedJob && teamSeedJob.status !== "not_started" && <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Team seed job · {teamSeedJob.year}</h3><span className={"text-sm font-semibold " + statusTone(teamSeedJob.status === "completed" ? "succeeded" : teamSeedJob.status === "completed_with_errors" ? "partial" : "running")}>{teamSeedJob.status.replaceAll("_", " ")}</span></div>
        <p className="mt-2 text-xs text-[var(--fv-muted)]">Stage: {teamSeedJob.stage ?? "queued"} · Historical events scheduled: {teamSeedJob.scheduledEvents ?? 0} / {teamSeedJob.eventKeys?.length ?? "pending"}</p>
        {teamSeedJob.errors?.length ? <div className="mt-2 space-y-1 text-xs text-rose-600">{teamSeedJob.errors.slice(-5).map((item, index) => <p key={item.event_key + index}>{item.event_key}: {item.detail}</p>)}</div> : null}
      </Panel>}
      {isEvent && eventTeamSeed && eventTeamSeed.status !== "not_started" && <Panel><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Event team seeding</h3><span className={"text-sm font-semibold " + statusTone(eventTeamSeed.status === "completed" ? "succeeded" : eventTeamSeed.status === "completed_with_errors" ? "partial" : "running")}>{eventTeamSeed.status.replaceAll("_", " ")}</span></div><div className="mt-2 grid gap-2 text-xs sm:grid-cols-4"><div>Participants: {eventTeamSeed.teamKeys?.length ?? 0}</div><div>Teams seeded: {eventTeamSeed.seededTeams ?? 0}</div><div>Teams failed: {eventTeamSeed.failedTeams ?? 0}</div><div>Historical events scheduled: {eventTeamSeed.historicalEventsScheduled ?? 0}</div></div>{eventTeamSeed.status === "running" && <p className="mt-2 text-xs text-[var(--fv-muted)]">Current team: {eventTeamSeed.activeTeamKey ?? "Preparing"} · {eventTeamSeed.cursor ?? 0} / {eventTeamSeed.teamKeys?.length ?? 0}</p>}{eventTeamSeed.errors?.length ? <div className="mt-2 space-y-1 text-xs text-rose-600">{eventTeamSeed.errors.slice(-5).map((item, index) => <p key={item.team_key + index}>{item.team_key}: {item.detail}</p>)}</div> : null}</Panel>}
      {isEvent && <Panel><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Canonical EventState</h3><span className={"text-sm font-semibold " + statusTone(entity.state?.event_state?.status)}>{entity.state?.event_state?.status ?? "missing"}</span></div><div className="mt-2 grid gap-2 text-xs sm:grid-cols-2"><div>Generated: {time(entity.state?.event_state?.generated_at)}</div><div>Source revision: {entity.state?.event_state?.source_revision ?? "—"}</div></div></Panel>}
      {isEvent && <Panel><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Canonical EventAnalytics</h3><span className={"text-sm font-semibold " + statusTone(entity.state?.analytics?.status)}>{entity.state?.analytics?.status ?? "not calculated"}</span></div><div className="mt-2 grid gap-2 text-xs sm:grid-cols-3"><div>Last calculated: {time(entity.state?.analytics?.last_calculated_at)}</div><div>Source revision: {entity.state?.analytics?.source_revision ?? "—"}</div><div>Season TeamRuntime revision: {entity.state?.analytics?.season_team_revision ?? "—"}</div><div>Next calculation: {time(entity.state?.analytics?.due_at)}</div></div>{entity.state?.analytics?.last_error && <p className="mt-2 text-xs text-rose-600">{entity.state.analytics.last_error}</p>}</Panel>}
      <Panel><h3 className="font-bold">Provider resources</h3><div className="mt-3 space-y-2">{resources.map((resource) => <div key={resource.endpoint} className="rounded-lg border border-[var(--fv-border)] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold capitalize">{provider(resource.endpoint)} · {endpointLabel(resource.endpoint)}</p><p className="mt-1 break-all font-mono text-[10px] text-[var(--fv-muted)]">{resource.endpoint}</p></div><span className={"text-xs font-bold " + statusTone(resource.status)}>{resource.status ?? "unknown"}</span></div><div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--fv-muted)]"><span>Revision {resource.revision ?? "—"}</span><span>Fetched {ago(resource.lastFetchedAt ?? resource.last_fetched_at)}</span><span>Attempted {ago(resource.lastAttemptAt ?? resource.last_attempt_at)}</span><span>HTTP {resource.lastHttpStatus ?? resource.http_status ?? "—"}</span><span>Records {resource.record_count ?? "—"}</span><span>Included {resource.included_count ?? "—"}</span></div>{(resource.lastError || resource.last_error) && <p className="mt-2 break-words text-xs text-rose-600">{resource.lastError ?? resource.last_error}</p>}{isEvent && <button disabled={busy} onClick={() => void dispatch("event", "resource-refresh", selected.key, resource.endpoint)} className="mt-2 rounded-md border border-[var(--fv-border)] px-2 py-1 text-xs disabled:opacity-40">Refresh resource</button>}</div>)}{!resources.length && <p className="py-6 text-sm text-[var(--fv-muted)]">No provider resources have been acquired for this object.</p>}</div></Panel>
      <Panel><h3 className="font-bold">Legacy runtime task records</h3><p className="mt-1 text-xs text-[var(--fv-muted)]">Temporary visibility into the former per-runtime alarm scheduler while it is migrated out. New refresh commands use direct coordinator dispatch.</p><div className="mt-3 space-y-2">{tasks.map((task) => <div key={task.endpoint} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--fv-border)] p-3 text-xs"><div className="min-w-0"><p className="font-semibold">{endpointLabel(task.endpoint)}</p><p className="break-all text-[var(--fv-muted)]">{task.endpoint}</p></div><div className="text-right text-[var(--fv-muted)]"><p>{time(task.due_at)}</p><p>{task.interval_ms == null ? "One-shot" : Math.round(task.interval_ms / 60000) + "m interval"} · {task.attempts} attempts</p></div></div>)}{!tasks.length && <p className="py-6 text-sm text-[var(--fv-muted)]">No legacy task records.</p>}</div></Panel>
      </>}
    </section>}

    {tab === "system" && !selected && <><Panel><h2 className="font-bold">Season workflows</h2><p className="mt-1 text-sm text-[var(--fv-muted)]">Resolve TBA's canonical season independently, or run readiness for the explicitly selected year ({year}). Readiness checks existing state and queues only missing or stale refreshes.</p><div className="mt-4 flex flex-wrap gap-2"><button disabled={busy} onClick={() => void runSeasonWorkflow("season-status-resolver")} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold disabled:opacity-40">Resolve canonical season</button><button disabled={busy || !Number.isInteger(year) || year < 1992 || year > 2200} onClick={() => void runSeasonWorkflow("team-readiness")} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Run team readiness</button><button disabled={busy || !Number.isInteger(year) || year < 1992 || year > 2200} onClick={() => void runSeasonWorkflow("event-readiness")} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Run event readiness</button></div></Panel><div className="mt-6"><WorkflowRunsPanel authenticated={authenticated} year={overview?.current_season?.year ?? 0} /></div><section className="mt-6 grid grid-cols-1 gap-4"><Panel><h2 className="font-bold">Current-season discovery</h2><p className="mt-1 text-sm text-[var(--fv-muted)]">TBA /status selects the canonical season. Discovery publishes the event and team directories; event and team runtime readiness are operated separately above.</p><div className="mt-3 grid gap-3 text-sm sm:grid-cols-3"><div><p className="text-xs text-[var(--fv-muted)]">Season</p>{overview?.current_season?.year ?? "Unavailable"}</div><div><p className="text-xs text-[var(--fv-muted)]">Directory status</p><strong className={statusTone(overview?.current_season?.status)}>{overview?.current_season?.status ?? "Unavailable"}</strong></div><div><p className="text-xs text-[var(--fv-muted)]">Events discovered</p>{overview?.current_season?.event_count ?? "—"}</div></div>{discoveryJob && discoveryJob.status !== "not_started" && <div className="mt-3 rounded-lg border border-[var(--fv-border)] p-3 text-xs"><div className="flex items-center justify-between gap-2"><strong>Manual season discovery</strong><span className={statusTone(discoveryJob.status === "completed" ? "succeeded" : discoveryJob.status === "failed" ? "failed" : "running")}>{discoveryJob.status.replaceAll("_", " ")}</span></div><p className="mt-1 text-[var(--fv-muted)]">Year {discoveryJob.year} · Stage: {discoveryJob.stage} · {discoveryJob.events ?? 0} events · {discoveryJob.teams ?? 0} teams · {discoveryJob.steps ?? 0} steps</p>{discoveryJob.error && <p className="mt-1 text-rose-600">{discoveryJob.error}</p>}</div>}</Panel><Panel><h2 className="font-bold">Realtime multiplexer</h2><p className="mt-2 text-sm">{overview?.multiplexer?.connected_sockets ?? "Unavailable"} sockets · {overview?.multiplexer?.clients ?? 0} clients</p><div className="mt-3 space-y-1 text-xs text-[var(--fv-muted)]">{overview?.multiplexer?.subscriptions?.map((item) => <p key={item.topic}>{item.topic}: {item.clients} clients</p>)}</div></Panel></section></>}

    <footer className="mt-8 text-xs text-[var(--fv-muted)]">Inventory covers the selected year's discovered event/team snapshot, plus registered runtime objects in the searchable directories. Full-season ingestion is an explicit, previewed operation with durable progress; it does not merge, deploy, or change production routing.</footer>
  </main>;
}
