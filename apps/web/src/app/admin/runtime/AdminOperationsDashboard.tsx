"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

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
  analytics?: { status?: string; due_at?: number | null; last_calculated_at?: number | null; source_revision?: number | null; last_error?: string | null };
  lifecycle?: { completed_until?: number | null };
  endpoints?: Record<string, Endpoint> | Endpoint[];
  polling?: Task[];
  diagnostics?: Array<{ endpoint: string; http_status: number | null; last_error: string | null }>;
};
type Entity = { key: string; status: number; error?: string; state?: EntityState | null };
type Overview = {
  generated_at: string;
  scheduler: { enabled: boolean; last_run_at: number | null; next_alarm_at: number | null; last_error: string | null; team_discovery_error: string | null };
  events: Entity[]; teams: Entity[];
  multiplexer: { connected_sockets: number | null; clients: number; subscriptions: Array<{ topic: string; clients: number }> } | null;
  inventory: { events: number; teams: number }; truncated: boolean;
};
type InventoryPage = { total: number; cursor: number; next_cursor: number | null; keys: string[]; year?: number; discovery_ready?: boolean };
type CoverageAudit = {
  year: number; status: "not_started" | "running" | "completed";
  started_at?: number; updated_at?: number; cursor?: number; processed?: number; total?: number; remaining?: number;
  counts?: { events_total: number; teams_total: number; event_runtime_missing: number; team_runtime_missing: number; event_analytics_missing: number; event_resources_incomplete: number; team_resources_incomplete: number; read_errors: number };
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
  if (status === "stale" || status === "pending" || status === "unknown" || status === "running") return "text-amber-600";
  return "text-[var(--fv-muted)]";
}

export default function AdminOperationsDashboard() {
  const [token, setToken] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [kind, setKind] = useState<Kind>("event");
  const [query, setQuery] = useState("");
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [page, setPage] = useState<InventoryPage | null>(null);
  const [coverageAudit, setCoverageAudit] = useState<CoverageAudit | null>(null);
  const [cursor, setCursor] = useState(0);
  const [entity, setEntity] = useState<Entity | null>(null);
  const [selected, setSelected] = useState<{ kind: Kind; key: string; year: number } | null>(null);
  const [tab, setTab] = useState<"home" | "events" | "teams" | "system">("home");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const requestHeaders = useMemo(() => ({ Authorization: "Bearer " + token }), [token]);
  const refresh = useCallback(async (quiet = false) => {
    if (!token) return;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/admin/runtime", { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load operations overview");
      setOverview(body as Overview); setAuthenticated(true); setError(""); setUpdatedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load runtime state");
      if (!quiet) setAuthenticated(false);
    } finally { if (!quiet) setLoading(false); }
  }, [token, requestHeaders]);

  const loadInventory = useCallback(async (nextCursor = 0) => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ inventory: kind, q: query, cursor: String(nextCursor), limit: "50", year: String(year) });
      const response = await fetch("/api/admin/runtime?" + params, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to search inventory");
      setPage(body as InventoryPage); setCursor(nextCursor); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Inventory search failed"); }
    finally { setLoading(false); }
  }, [token, kind, query, year, requestHeaders]);

  const loadCoverageAudit = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch("/api/admin/runtime?coverageAudit=" + year, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (response.ok) setCoverageAudit(body as CoverageAudit);
    } catch { /* Keep the last known audit result visible. */ }
  }, [token, year, requestHeaders]);

  const runCoverageAudit = useCallback(async () => {
    if (!token) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const action = coverageAudit?.status === "running" ? "coverage-audit-continue" : "coverage-audit-start";
      const response = await fetch("/api/admin/runtime", {
        method: "POST", headers: { ...requestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "system", action, year }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Coverage audit failed");
      setCoverageAudit(body as CoverageAudit);
      setMessage(coverageAudit?.status === "running" ? "Coverage audit batch completed." : "Coverage audit started. Run additional batches until complete.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Coverage audit failed"); }
    finally { setBusy(false); }
  }, [token, requestHeaders, year, coverageAudit]);

  const openEntity = useCallback(async (entityKind: Kind, key: string, entityYear = year) => {
    setSelected({ kind: entityKind, key, year: entityYear });
    setEntity(null); setError(""); setMessage("");
    window.history.pushState(null, "", "/admin/runtime?" + entityKind + "=" + encodeURIComponent(key) + "&year=" + entityYear);
    try {
      const params = new URLSearchParams({ kind: entityKind, key, year: String(entityYear) });
      const response = await fetch("/api/admin/runtime?" + params, { headers: requestHeaders, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load command center");
      setEntity({ key, status: response.status, state: body as EntityState });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load entity state"); }
  }, [requestHeaders, year]);

  const dispatch = useCallback(async (entityKind: Kind | "system", action: string, key?: string, endpoint?: string, operationYear?: number) => {
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/admin/runtime", {
        method: "POST", headers: { ...requestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: entityKind, action, ...(key ? { key } : {}), ...(endpoint ? { endpoint } : {}), ...(operationYear ? { year: operationYear } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Operation failed");
      setMessage(action.replaceAll("-", " ") + " accepted.");
      await refresh(true);
      if (entityKind !== "system" && key) await openEntity(entityKind, key, selected?.year ?? year);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Operation failed"); }
    finally { setBusy(false); }
  }, [requestHeaders, refresh, openEntity, selected, year]);

  useEffect(() => {
    if (!authenticated || !token) return;
    const timer = window.setInterval(() => void refresh(true), 15_000);
    return () => window.clearInterval(timer);
  }, [authenticated, token, refresh]);

  useEffect(() => {
    if (!authenticated) return;
    void loadCoverageAudit();
  }, [authenticated, loadCoverageAudit]);

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

  const sampled = useMemo(() => {
    const events = overview?.events ?? [], teams = overview?.teams ?? [];
    const eventAnalyticsMissing = events.filter((item) => !["succeeded", "partial"].includes(item.state?.analytics?.status ?? "")).length;
    const eventWithoutSources = events.filter((item) => endpointRows(item.state).length === 0).length;
    const teamWithoutSources = teams.filter((item) => endpointRows(item.state).length === 0).length;
    return {
      events: events.length, teams: teams.length,
      eventAnalyticsMissing, eventWithoutSources, teamWithoutSources,
      failed: [...events, ...teams].filter((item) => item.status !== 200).length,
    };
  }, [overview]);

  const resources = endpointRows(entity?.state);
  const tasks = entity?.state?.polling ?? [];
  const isEvent = selected?.kind === "event";

  if (!authenticated) return <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-12">
    <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FieldView operations</p>
    <h1 className="mt-1 text-3xl font-bold">Command center</h1>
    <p className="mt-2 text-sm text-[var(--fv-muted)]">Authenticate to inspect event and team runtimes and manage controlled ingestion.</p>
    <form className="mt-7 space-y-3" onSubmit={(event) => { event.preventDefault(); void refresh(); }}>
      <label htmlFor="admin-token" className="block text-sm font-semibold">Dashboard access token</label>
      <input id="admin-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} className="w-full rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-4 py-3 text-sm" placeholder="Enter admin access token" />
      {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
      <button disabled={!token || loading} className="w-full rounded-xl bg-[var(--fv-brand)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{loading ? "Connecting…" : "Open command center"}</button>
    </form>
    <p className="mt-5 text-xs text-[var(--fv-muted)]">The dashboard access token is separate from the server-only Worker token.</p>
  </main>;

  return <main className="custom-scrollbar mx-auto h-dvh w-full max-w-[1500px] overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 py-7 sm:px-6 lg:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FieldView operations</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Command center</h1><p className="mt-1 text-sm text-[var(--fv-muted)]">A focused view of runtime health, canonical data coverage, and ingestion work.</p></div>
      <div className="flex items-center gap-2"><span className="text-xs text-[var(--fv-muted)]">Updated {ago(updatedAt)}</span><button onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold">Refresh</button><button onClick={() => { setAuthenticated(false); setOverview(null); setToken(""); setSelected(null); }} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold">Sign out</button></div>
    </header>
    {(error || message) && <div role={error ? "alert" : "status"} className={"mt-4 rounded-xl border px-4 py-3 text-sm " + (error ? "border-rose-300 text-rose-700" : "border-[var(--fv-border)]")}>{error || message}</div>}
    <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-[var(--fv-border)]" aria-label="Operations sections">
      {(["home", "events", "teams", "system"] as const).map((item) => <button key={item} onClick={() => { setTab(item); if (item === "events" || item === "teams") setKind(item === "events" ? "event" : "team"); setSelected(null); setEntity(null); setQuery(""); window.history.pushState(null, "", "/admin/runtime"); }} className={"shrink-0 border-b-2 px-4 py-3 text-sm font-semibold capitalize " + (tab === item ? "border-[var(--fv-brand)] text-[var(--fv-text)]" : "border-transparent text-[var(--fv-muted)]")}>{item === "home" ? "Overview" : item}</button>)}
    </nav>

    {tab === "home" && <div className="mt-6 space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[["Registered events", overview?.inventory.events ?? 0], ["Registered teams", overview?.inventory.teams ?? 0], ["Sampled events without analytics", sampled.eventAnalyticsMissing], ["Runtime errors in sample", sampled.failed]].map(([label, value]) => <Panel key={String(label)}><p className="text-xs text-[var(--fv-muted)]">{label}</p><p className="mt-1 text-2xl font-bold tabular-nums">{value}</p></Panel>)}
      </div>
      <Panel><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-bold">Data coverage</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">The overview samples at most 250 objects of each type. These are sample counts, not full-inventory totals.</p></div><span className="text-xs text-[var(--fv-muted)]">{sampled.events} events · {sampled.teams} teams inspected</span></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-lg border border-[var(--fv-border)] p-3"><p className="text-xs text-[var(--fv-muted)]">Events with no provider resources</p><p className="mt-1 text-xl font-bold">{sampled.eventWithoutSources}</p></div><div className="rounded-lg border border-[var(--fv-border)] p-3"><p className="text-xs text-[var(--fv-muted)]">Events without completed analytics</p><p className="mt-1 text-xl font-bold">{sampled.eventAnalyticsMissing}</p></div><div className="rounded-lg border border-[var(--fv-border)] p-3"><p className="text-xs text-[var(--fv-muted)]">Teams with no provider resources</p><p className="mt-1 text-xl font-bold">{sampled.teamWithoutSources}</p></div></div>
        <div className="mt-4 border-t border-[var(--fv-border)] pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="text-sm font-bold">Full-season coverage audit</h3><p className="mt-1 text-xs text-[var(--fv-muted)]">Reads every discovered event and team runtime in the selected season. This makes no provider API requests and processes up to 20 runtimes per batch.</p></div>
            <div className="flex flex-wrap items-center gap-2"><label className="text-xs text-[var(--fv-muted)]">Year <input aria-label="Coverage audit year" type="number" min="1992" max="2200" value={year} onChange={(event) => setYear(Number(event.target.value))} className="ml-1 w-20 rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-2 py-2 text-sm text-[var(--fv-text)]" /></label><button disabled={busy} onClick={() => void runCoverageAudit()} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{coverageAudit?.status === "running" ? "Run next batch" : coverageAudit?.status === "completed" ? "Run audit again" : "Start full audit"}</button></div>
          </div>
          {coverageAudit && coverageAudit.year === year && <div className="mt-3 space-y-2">
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="font-semibold capitalize">{coverageAudit.status.replaceAll("_", " ")}</span><span>{coverageAudit.processed ?? coverageAudit.cursor ?? 0} / {coverageAudit.total ?? ((coverageAudit.counts?.events_total ?? 0) + (coverageAudit.counts?.teams_total ?? 0))} runtimes inspected</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--fv-border)]"><div className="h-full rounded-full bg-[var(--fv-brand)]" style={{ width: ((coverageAudit.processed ?? coverageAudit.cursor ?? 0) / Math.max(1, coverageAudit.total ?? ((coverageAudit.counts?.events_total ?? 0) + (coverageAudit.counts?.teams_total ?? 0)))) * 100 + "%" }} /></div>
            {coverageAudit.counts && <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {[["Events", coverageAudit.counts.events_total], ["Teams", coverageAudit.counts.teams_total], ["Events missing analytics", coverageAudit.counts.event_analytics_missing], ["Events with incomplete resources", coverageAudit.counts.event_resources_incomplete], ["Teams with incomplete resources", coverageAudit.counts.team_resources_incomplete], ["Missing event runtimes", coverageAudit.counts.event_runtime_missing], ["Missing team runtimes", coverageAudit.counts.team_runtime_missing], ["Read errors", coverageAudit.counts.read_errors]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-[var(--fv-border)] p-2"><p className="text-[10px] text-[var(--fv-muted)]">{label}</p><p className="text-lg font-bold tabular-nums">{value}</p></div>)}
            </div>}
            {coverageAudit.status === "running" && <p className="text-xs text-[var(--fv-muted)]">Progress is saved durably. Use “Run next batch” to continue; you can leave this page and resume later.</p>}
            {coverageAudit.status === "completed" && <p className="text-xs text-emerald-600">Full inventory audit completed for {year}. Counts cover the discovered season snapshot, not just the dashboard sample.</p>}
          </div>}
          {(!coverageAudit || coverageAudit.year !== year) && <p className="mt-3 text-xs text-[var(--fv-muted)]">No audit has been run for {year}. Discover the season from the event or team directory first if its snapshot is not already cached.</p>}
        </div>
      </Panel>
      <Panel><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold">Global discovery scheduler</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">Discovers the current season's events and teams and maintains event lifecycle polling.</p></div><strong className={overview?.scheduler.enabled ? "text-emerald-600" : "text-amber-600"}>{overview?.scheduler.enabled ? "Running" : "Stopped"}</strong></div><div className="mt-3 grid gap-3 text-sm sm:grid-cols-3"><div><p className="text-xs text-[var(--fv-muted)]">Last run</p>{time(overview?.scheduler.last_run_at)}</div><div><p className="text-xs text-[var(--fv-muted)]">Next alarm</p>{time(overview?.scheduler.next_alarm_at)}</div><div><p className="text-xs text-[var(--fv-muted)]">Registered inventory</p>{overview?.inventory.events ?? 0} events / {overview?.inventory.teams ?? 0} teams</div></div></Panel>
    </div>}

    {(tab === "events" || tab === "teams") && !selected && <section className="mt-6 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-bold">{tab === "events" ? "Event directory" : "Team directory"}</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">Search the full registered inventory and open an individual command center.</p></div><div className="flex flex-wrap gap-2"><label className="flex items-center gap-2 text-xs text-[var(--fv-muted)]">Season <input aria-label="Inventory season year" type="number" min="1992" max={new Date().getUTCFullYear() + 1} value={year} onChange={(event) => setYear(Number(event.target.value))} className="w-24 rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-2 py-2 text-sm text-[var(--fv-text)]" /></label><input aria-label="Search inventory" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "events" ? "Search event key…" : "Search team key…"} className="w-64 rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-3 py-2 text-sm" /><button onClick={() => void loadInventory(0)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm">Search</button></div></div>
      <Panel><div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold">{page?.total ?? 0} matching registered {kind}s</p><p className="text-xs text-[var(--fv-muted)]">Season {year} · 50 per page</p></div>{page && !page.discovery_ready && <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 px-3 py-2"><p className="text-xs text-amber-700">No {year} discovery snapshot is cached yet. Results include only previously registered runtime objects.</p><button disabled={busy} onClick={async () => { await dispatch("system", "discover-year", undefined, undefined, year); await loadInventory(0); }} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Discover {year} season</button></div>}<div className="mt-3 divide-y divide-[var(--fv-border)]">{(page?.keys ?? []).map((key) => {
        const summary = (kind === "event" ? overview?.events : overview?.teams)?.find((item) => item.key === key);
        const state = summary?.state;
        const endpointCount = endpointRows(state).length;
        const analyticsStatus = state?.analytics?.status;
        return <button key={key} onClick={() => void openEntity(kind, key, year)} className="flex w-full flex-wrap items-center justify-between gap-3 py-3 text-left hover:bg-[var(--fv-brand-soft)]/30"><span><strong className="text-sm">{key}</strong><span className="ml-3 text-xs text-[var(--fv-muted)]">{endpointCount} resources{kind === "event" ? " · analytics " + (analyticsStatus ?? "not calculated") : ""}</span></span><span className="text-xs text-[var(--fv-brand)]">Open command center →</span></button>;
      })}{!page?.keys.length && <p className="py-8 text-center text-sm text-[var(--fv-muted)]">No registered objects match this search.</p>}</div><div className="mt-3 flex items-center justify-between"><button disabled={cursor === 0 || loading} onClick={() => void loadInventory(Math.max(0, cursor - 50))} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-xs disabled:opacity-40">Previous</button><span className="text-xs text-[var(--fv-muted)]">{page ? page.cursor + 1 : 0}–{Math.min((page?.cursor ?? 0) + 50, page?.total ?? 0)} of {page?.total ?? 0}</span><button disabled={page?.next_cursor == null || loading} onClick={() => void loadInventory(page?.next_cursor ?? 0)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-xs disabled:opacity-40">Next</button></div></Panel>
    </section>}

    {selected && <section className="mt-6 space-y-4">
      <button onClick={() => { setSelected(null); setEntity(null); window.history.pushState(null, "", "/admin/runtime"); }} className="text-sm font-semibold text-[var(--fv-brand)]">← Back to {selected.kind} directory</button>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-[var(--fv-brand)]">{selected.kind} command center</p><h2 className="mt-1 text-2xl font-bold">{selected.key}</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">{resources.length} provider resources · {tasks.length} scheduled tasks</p></div><div className="flex flex-wrap gap-2">{isEvent ? <><button disabled={busy} onClick={() => void dispatch("event", "refresh", selected.key)} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Refresh event</button><button disabled={busy} onClick={() => void dispatch("event", "statbotics-refresh", selected.key)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">Refresh Statbotics</button><button disabled={busy} onClick={() => void dispatch("event", "recalculate", selected.key)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">Recalculate analytics</button></> : <><button disabled={busy} onClick={() => void dispatch("team", "refresh", selected.key)} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Refresh team</button><button disabled={busy} onClick={() => void dispatch("team", "seed", selected.key)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">Seed team + events</button></>}</div></div>
      {!entity && <Panel><p className="text-sm text-[var(--fv-muted)]">Loading entity state…</p></Panel>}
      {entity && <><div className="grid gap-3 sm:grid-cols-3"><Panel><p className="text-xs text-[var(--fv-muted)]">Provider resources</p><p className="mt-1 text-2xl font-bold">{resources.length}</p></Panel><Panel><p className="text-xs text-[var(--fv-muted)]">Scheduled tasks</p><p className="mt-1 text-2xl font-bold">{tasks.length}</p></Panel><Panel><p className="text-xs text-[var(--fv-muted)]">{isEvent ? "Analytics status" : "Team runtime"}</p><p className={"mt-1 text-lg font-bold " + statusTone(isEvent ? entity.state?.analytics?.status : entity.status === 200 ? "available" : "failed")}>{isEvent ? entity.state?.analytics?.status ?? "not calculated" : entity.status === 200 ? "reachable" : "unavailable"}</p></Panel></div>
      {isEvent && <Panel><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Canonical analytics</h3><span className={"text-sm font-semibold " + statusTone(entity.state?.analytics?.status)}>{entity.state?.analytics?.status ?? "not calculated"}</span></div><div className="mt-2 grid gap-2 text-xs sm:grid-cols-3"><div>Last calculated: {time(entity.state?.analytics?.last_calculated_at)}</div><div>Source revision: {entity.state?.analytics?.source_revision ?? "—"}</div><div>Next calculation: {time(entity.state?.analytics?.due_at)}</div></div>{entity.state?.analytics?.last_error && <p className="mt-2 text-xs text-rose-600">{entity.state.analytics.last_error}</p>}</Panel>}
      <Panel><h3 className="font-bold">Provider resources</h3><div className="mt-3 space-y-2">{resources.map((resource) => <div key={resource.endpoint} className="rounded-lg border border-[var(--fv-border)] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold capitalize">{provider(resource.endpoint)} · {endpointLabel(resource.endpoint)}</p><p className="mt-1 break-all font-mono text-[10px] text-[var(--fv-muted)]">{resource.endpoint}</p></div><span className={"text-xs font-bold " + statusTone(resource.status)}>{resource.status ?? "unknown"}</span></div><div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--fv-muted)]"><span>Revision {resource.revision ?? "—"}</span><span>Fetched {ago(resource.lastFetchedAt ?? resource.last_fetched_at)}</span><span>Attempted {ago(resource.lastAttemptAt ?? resource.last_attempt_at)}</span><span>HTTP {resource.lastHttpStatus ?? resource.http_status ?? "—"}</span><span>Records {resource.record_count ?? "—"}</span><span>Included {resource.included_count ?? "—"}</span></div>{(resource.lastError || resource.last_error) && <p className="mt-2 break-words text-xs text-rose-600">{resource.lastError ?? resource.last_error}</p>}{isEvent && <button disabled={busy} onClick={() => void dispatch("event", "resource-refresh", selected.key, resource.endpoint)} className="mt-2 rounded-md border border-[var(--fv-border)] px-2 py-1 text-xs disabled:opacity-40">Refresh resource</button>}</div>)}{!resources.length && <p className="py-6 text-sm text-[var(--fv-muted)]">No provider resources have been acquired for this object.</p>}</div></Panel>
      <Panel><h3 className="font-bold">Scheduled work</h3><div className="mt-3 space-y-2">{tasks.map((task) => <div key={task.endpoint} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--fv-border)] p-3 text-xs"><div className="min-w-0"><p className="font-semibold">{endpointLabel(task.endpoint)}</p><p className="break-all text-[var(--fv-muted)]">{task.endpoint}</p></div><div className="text-right text-[var(--fv-muted)]"><p>{time(task.due_at)}</p><p>{task.interval_ms == null ? "One-shot" : Math.round(task.interval_ms / 60000) + "m interval"} · {task.attempts} attempts</p></div></div>)}{!tasks.length && <p className="py-6 text-sm text-[var(--fv-muted)]">No scheduled tasks.</p>}</div></Panel>
      </>}
    </section>}

    {tab === "system" && !selected && <section className="mt-6 grid gap-4 lg:grid-cols-2"><Panel><h2 className="font-bold">Global scheduler</h2><p className="mt-1 text-sm text-[var(--fv-muted)]">Controls routine discovery and event lifecycle polling.</p><p className="mt-3 text-sm">Status: <strong className={overview?.scheduler.enabled ? "text-emerald-600" : "text-amber-600"}>{overview?.scheduler.enabled ? "Running" : "Stopped"}</strong></p><p className="mt-1 text-xs text-[var(--fv-muted)]">Last run {time(overview?.scheduler.last_run_at)} · Next alarm {time(overview?.scheduler.next_alarm_at)}</p><div className="mt-4 flex flex-wrap gap-2"><button disabled={busy || overview?.scheduler.enabled} onClick={() => void dispatch("system", "scheduler-start")} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Start</button><button disabled={busy || !overview?.scheduler.enabled} onClick={() => void dispatch("system", "scheduler-stop")} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">Stop</button><button disabled={busy} onClick={() => void dispatch("system", "scheduler-run")} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-40">Run discovery now</button></div>{overview?.scheduler.last_error && <p className="mt-3 text-xs text-rose-600">Events: {overview.scheduler.last_error}</p>}{overview?.scheduler.team_discovery_error && <p className="mt-1 text-xs text-rose-600">Teams: {overview.scheduler.team_discovery_error}</p>}</Panel><Panel><h2 className="font-bold">Realtime multiplexer</h2><p className="mt-2 text-sm">{overview?.multiplexer?.connected_sockets ?? "Unavailable"} sockets · {overview?.multiplexer?.clients ?? 0} clients</p><div className="mt-3 space-y-1 text-xs text-[var(--fv-muted)]">{overview?.multiplexer?.subscriptions?.map((item) => <p key={item.topic}>{item.topic}: {item.clients} clients</p>)}</div></Panel></section>}

    <footer className="mt-8 text-xs text-[var(--fv-muted)]">Inventory covers objects registered through FieldView, not every Durable Object in the Cloudflare account. Full season ingestion and a complete background coverage audit are being added as separately controlled operations.</footer>
  </main>;
}
