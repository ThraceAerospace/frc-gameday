"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

type Tab = "overview" | "events" | "teams" | "providers" | "tasks" | "attention" | "system";
type Endpoint = {
  endpoint: string; status?: string; revision?: number;
  lastFetchedAt?: number | null; lastAttemptAt?: number | null;
  last_fetched_at?: number | null; last_attempt_at?: number | null;
  lastError?: string | null; last_error?: string | null;
  lastHttpStatus?: number | null; http_status?: number | null;
  expiresAt?: number | null; expires_at?: number | null;
  record_count?: number; included_count?: number; excluded_count?: number;
  data_kind?: string;
};
type Task = { endpoint: string; due_at: number; interval_ms: number | null; attempts: number; retry_on_failure?: boolean; authoritative_refetch_at?: number };
type RuntimeEntry = {
  key: string; status: number; error?: string;
  state?: {
    event_key?: string; team_key?: string;
    analytics?: { due_at?: number | null; status?: string; last_calculated_at?: number | null; source_revision?: number | null; last_error?: string | null };
    polling?: Task[]; endpoints?: Record<string, Endpoint> | Endpoint[];
    diagnostics?: Array<{ endpoint: string; http_status: number | null; last_error: string | null }>;
  } | null;
};
type Overview = {
  generated_at: string;
  scheduler: { enabled: boolean; last_run_at: number | null; next_alarm_at: number | null; last_error: string | null; team_discovery_error: string | null };
  events: RuntimeEntry[]; teams: RuntimeEntry[];
  multiplexer: { connected_sockets: number | null; clients: number; subscriptions: Array<{ topic: string; clients: number }> } | null;
  inventory: { events: number; teams: number }; truncated: boolean; error?: string;
};

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "events", label: "Events" },
  { id: "teams", label: "Teams" }, { id: "providers", label: "Providers" },
  { id: "tasks", label: "Tasks" }, { id: "attention", label: "Attention" }, { id: "system", label: "System" },
];
function dateTime(value?: number | null) {
  if (value == null) return "—";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(value));
}
function age(value?: number | null) {
  if (value == null) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}
function endpointRows(entry: RuntimeEntry): Endpoint[] {
  const values = entry.state?.endpoints;
  if (Array.isArray(values)) {
    const diagnostics = new Map((entry.state?.diagnostics ?? []).map((item) => [item.endpoint, item]));
    return values.map((value) => ({ ...value, ...(diagnostics.get(value.endpoint) ?? {}) }));
  }
  return Object.entries(values ?? {}).map(([key, value]) => ({ ...value, endpoint: value.endpoint ?? key.replace(/^endpoint:/, "") }));
}
function providerName(raw: string) {
  const path = raw.toLowerCase();
  if (path.includes("statbotics") || path.startsWith("/matches?") || path.startsWith("/team_year") || path.startsWith("/team_events?")) return "Statbotics";
  if (path.includes("frc-colors") || path.startsWith("/team/") && !path.startsWith("/team/frc")) return "FRC Colors";
  if (path.startsWith("/event/") || path.startsWith("/team/frc") || path.includes("thebluealliance")) return "The Blue Alliance";
  return "Other";
}
function endpointTitle(raw: string) {
  const url = new URL(raw, "https://fieldview.invalid");
  const path = url.pathname;
  if (path === "/matches" && url.searchParams.has("event")) return "Statbotics · Event match data";
  if (path === "/team_events") return "Statbotics · Team event statistics";
  if (path.startsWith("/event/")) return "TBA · " + (path.split("/").filter(Boolean).pop() ?? "Event");
  if (path.startsWith("/team/")) return "Team · " + path.split("/").filter(Boolean).slice(-1)[0];
  return providerName(raw) + " · " + (path.split("/").filter(Boolean).pop() ?? "Resource");
}
function tone(status?: string) {
  if (status === "available" || status === "succeeded" || status === "ok") return "text-emerald-600";
  if (status === "stale" || status === "unknown" || status === "pending" || status === "running") return "text-amber-600";
  if (status === "failed" || status === "unavailable" || status === "error") return "text-rose-600";
  return "text-[var(--fv-muted)]";
}
function Panel({ children }: { children: ReactNode }) {
  return <section className="rounded-2xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4 sm:p-5">{children}</section>;
}

export default function AdminRuntimeDashboard() {
  const [token, setToken] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [operationMessage, setOperationMessage] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    if (!token) return;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/admin/runtime", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Admin request failed (" + response.status + ")");
      setOverview(body as Overview); setAuthenticated(true); setError(""); setLastUpdated(Date.now());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to load runtime state";
      setError(message); if (!quiet) setAuthenticated(false);
    } finally { if (!quiet) setLoading(false); }
  }, [token]);

  const dispatch = useCallback(async (kind: "event" | "team" | "system", action: string, key?: string, endpoint?: string) => {
    const id = [kind, action, key, endpoint].filter(Boolean).join(":");
    setBusy(id); setOperationMessage("");
    try {
      const response = await fetch("/api/admin/runtime", {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ kind, action, ...(key ? { key } : {}), ...(endpoint ? { endpoint } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Operation failed (" + response.status + ")");
      setOperationMessage(action.replaceAll("-", " ") + " completed for " + (key ?? "system") + ".");
      await refresh(true);
    } catch (cause) {
      setOperationMessage("Operation failed: " + (cause instanceof Error ? cause.message : "Unknown error"));
    } finally { setBusy(null); }
  }, [token, refresh]);

  useEffect(() => {
    if (!authenticated || !token) return;
    const timer = window.setInterval(() => void refresh(true), 10_000);
    return () => window.clearInterval(timer);
  }, [authenticated, token, refresh]);

  const entries = useMemo(() => {
    const source = tab === "events" ? (overview?.events ?? []) : (overview?.teams ?? []);
    return source.filter((entry) => entry.key.toLowerCase().includes(filter.toLowerCase()));
  }, [overview, tab, filter]);
  const allResources = useMemo(() => [
    ...(overview?.events ?? []).flatMap((entry) => endpointRows(entry).map((endpoint) => ({ ...endpoint, owner: entry.key, ownerType: "Event" }))),
    ...(overview?.teams ?? []).flatMap((entry) => endpointRows(entry).map((endpoint) => ({ ...endpoint, owner: entry.key, ownerType: "Team" }))),
  ], [overview]);
  const allTasks = useMemo(() => [
    ...(overview?.events ?? []).flatMap((entry) => (entry.state?.polling ?? []).map((task) => ({ ...task, owner: entry.key, ownerType: "Event" }))),
    ...(overview?.teams ?? []).flatMap((entry) => (entry.state?.polling ?? []).map((task) => ({ ...task, owner: entry.key, ownerType: "Team" }))),
  ], [overview]);
  const counts = useMemo(() => ({
    objects: (overview?.events.length ?? 0) + (overview?.teams.length ?? 0),
    tasks: allTasks.length,
    due: allTasks.filter((task) => task.due_at <= Date.now()).length,
    stale: allResources.filter((resource) => resource.status === "stale").length,
    failed: allResources.filter((resource) => resource.status === "failed" || resource.status === "unavailable").length
      + (overview?.events ?? []).filter((entry) => entry.status !== 200).length
      + (overview?.teams ?? []).filter((entry) => entry.status !== 200).length,
  }), [overview, allTasks, allResources]);

  if (!authenticated) return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-12">
      <div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FieldView operations</div>
      <h1 className="text-3xl font-bold tracking-tight">Runtime admin</h1>
      <p className="mt-2 text-sm leading-6 text-[var(--fv-muted)]">Sign in to inspect runtime health and dispatch protected ingestion operations.</p>
      <form className="mt-7 space-y-3" onSubmit={(event) => { event.preventDefault(); void refresh(); }}>
        <label htmlFor="admin-token" className="block text-sm font-semibold">Dashboard access token</label>
        <input id="admin-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} className="w-full rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-4 py-3 text-sm" placeholder="Enter admin access token" />
        {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
        <button disabled={!token || loading} className="w-full rounded-xl bg-[var(--fv-brand)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{loading ? "Connecting…" : "Open dashboard"}</button>
      </form>
      <p className="mt-5 text-xs leading-5 text-[var(--fv-muted)]">The dashboard token is separate from the Worker service token. The service token remains server-side.</p>
    </div>
  );

  return <div className="custom-scrollbar mx-auto h-dvh w-full max-w-[1600px] overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 py-7 sm:px-6 lg:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FieldView operations</div><h1 className="mt-1 text-3xl font-bold tracking-tight">Operations console</h1><p className="mt-1 text-sm text-[var(--fv-muted)]">Inspect provider health, canonical data and scheduled work; dispatch controlled refresh and ingest operations.</p></div>
      <div className="flex items-center gap-2"><span className="text-xs text-[var(--fv-muted)]">Updated {lastUpdated ? age(lastUpdated) : "—"} · 10s</span><button onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold">{loading ? "Refreshing…" : "Refresh"}</button><button onClick={() => { setAuthenticated(false); setOverview(null); setToken(""); }} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold">Sign out</button></div>
    </header>
    {error && <div role="alert" className="mt-4 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
    {operationMessage && <div role="status" className="mt-4 rounded-xl border border-[var(--fv-border)] px-4 py-3 text-sm">{operationMessage}</div>}
    {overview?.truncated && <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">Inventory is capped at 250 event and 250 team objects per refresh.</div>}

    <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-[var(--fv-border)]" aria-label="Operations sections">
      {tabs.map((item) => <button key={item.id} onClick={() => { setTab(item.id); setFilter(""); }} className={"shrink-0 border-b-2 px-4 py-3 text-sm font-semibold " + (tab === item.id ? "border-[var(--fv-brand)] text-[var(--fv-text)]" : "border-transparent text-[var(--fv-muted)] hover:text-[var(--fv-text)]")}>{item.label}</button>)}
    </nav>

    {tab === "overview" && <div className="mt-6 space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{[["Durable Objects", counts.objects], ["Scheduled tasks", counts.tasks], ["Due now", counts.due], ["Stale resources", counts.stale], ["Failed / unavailable", counts.failed]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4"><div className="text-xs text-[var(--fv-muted)]">{label}</div><div className="mt-1 text-2xl font-bold tabular-nums">{value}</div></div>)}</div>
      <Panel><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold">Global event scheduler</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">Discovery and event lifecycle coordinator</p></div><span className={"font-bold " + (overview?.scheduler.enabled ? "text-emerald-600" : "text-amber-600")}>{overview?.scheduler.enabled ? "Running" : "Stopped"}</span></div><div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4"><div><div className="text-xs text-[var(--fv-muted)]">Last run (UTC)</div>{dateTime(overview?.scheduler.last_run_at)}</div><div><div className="text-xs text-[var(--fv-muted)]">Next alarm (UTC)</div>{dateTime(overview?.scheduler.next_alarm_at)}</div><div><div className="text-xs text-[var(--fv-muted)]">Event objects</div>{overview?.inventory.events ?? 0}</div><div><div className="text-xs text-[var(--fv-muted)]">Team objects</div>{overview?.inventory.teams ?? 0}</div></div>{(overview?.scheduler.last_error || overview?.scheduler.team_discovery_error) && <div className="mt-3 text-xs text-rose-600">Scheduler: {overview.scheduler.last_error ?? overview.scheduler.team_discovery_error}</div>}</Panel>
      <Panel><h2 className="font-bold">Provider coverage</h2><div className="mt-3 grid gap-3 sm:grid-cols-3">{["The Blue Alliance", "Statbotics", "FRC Colors"].map((provider) => { const resources = allResources.filter((resource) => providerName(resource.endpoint) === provider); const bad = resources.filter((resource) => ["failed", "unavailable", "stale"].includes(resource.status ?? "")).length; return <div key={provider} className="rounded-lg border border-[var(--fv-border)] p-3"><div className="font-semibold">{provider}</div><div className="mt-1 text-sm">{resources.length} resources · {bad} need attention</div></div>; })}</div></Panel>
      <Panel><h2 className="font-bold">Multiplexer</h2><p className="mt-2 text-sm text-[var(--fv-muted)]">{overview?.multiplexer?.connected_sockets ?? "Unavailable"} connections · {overview?.multiplexer?.clients ?? 0} clients</p><div className="mt-2 flex flex-wrap gap-2">{overview?.multiplexer?.subscriptions?.map((item) => <span key={item.topic} className="rounded-lg bg-[var(--fv-brand-soft)] px-2.5 py-1 text-xs">{item.topic}: {item.clients}</span>)}</div></Panel>
    </div>}

    {(tab === "events" || tab === "teams") && <section className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-bold">{tab === "events" ? "Event operations" : "Team operations"}</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">{entries.length} registered objects in current inventory</p></div><input aria-label="Filter inventory" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={"Filter " + tab + "…"} className="w-56 rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-3 py-2 text-sm" /></div>
      <div className="mt-3 space-y-3">{entries.map((entry) => { const resources = endpointRows(entry); const tasks = entry.state?.polling ?? []; const event = tab === "events"; return <Panel key={entry.key}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="font-bold">{entry.key}</h3><span className={"text-xs font-semibold " + (entry.status === 200 ? "text-emerald-600" : "text-rose-600")}>{entry.status === 200 ? "Reachable" : "HTTP " + entry.status}</span></div><p className="mt-1 text-xs text-[var(--fv-muted)]">{resources.length} resources · {tasks.length} scheduled tasks</p></div><div className="flex flex-wrap gap-2">{event ? <><button disabled={!!busy} onClick={() => void dispatch("event", "refresh", entry.key)} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Refresh all data</button><button disabled={!!busy} onClick={() => void dispatch("event", "statbotics-refresh", entry.key)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-xs font-semibold disabled:opacity-50">Refresh Statbotics</button><button disabled={!!busy} onClick={() => void dispatch("event", "recalculate", entry.key)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-xs font-semibold disabled:opacity-50">Recalculate analytics</button></> : <><button disabled={!!busy} onClick={() => void dispatch("team", "refresh", entry.key)} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Refresh team</button><button disabled={!!busy} onClick={() => void dispatch("team", "seed", entry.key)} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-xs font-semibold disabled:opacity-50">Seed team + events</button></>}</div></div>
        {event && <div className="mt-3 rounded-lg border border-[var(--fv-border)] p-3 text-xs"><div className="flex flex-wrap items-center gap-3"><strong>Canonical analytics</strong><span className={tone(entry.state?.analytics?.status)}>{entry.state?.analytics?.status ?? "pending"}</span><span className="text-[var(--fv-muted)]">Last calculated {dateTime(entry.state?.analytics?.last_calculated_at)}</span><span className="text-[var(--fv-muted)]">Source revision {entry.state?.analytics?.source_revision ?? "—"}</span></div>{entry.state?.analytics?.last_error && <p className="mt-1 text-rose-600">{entry.state.analytics.last_error}</p>}</div>}
        <div className="mt-3 grid gap-2 xl:grid-cols-2">{resources.map((resource) => <div key={resource.endpoint} className="rounded-lg border border-[var(--fv-border)] p-3 text-xs"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><div className="font-semibold">{endpointTitle(resource.endpoint)}</div><div className="mt-1 break-all font-mono text-[10px] text-[var(--fv-muted)]">{resource.endpoint}</div></div><span className={"font-bold " + tone(resource.status)}>{resource.status ?? "unknown"}</span></div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[var(--fv-muted)]"><span>Rev {resource.revision ?? "—"}</span><span>Fetched {age(resource.lastFetchedAt ?? resource.last_fetched_at)}</span><span>Attempted {age(resource.lastAttemptAt ?? resource.last_attempt_at)}</span><span>HTTP {resource.lastHttpStatus ?? resource.http_status ?? "—"}</span><span>Records {resource.record_count ?? "—"}</span><span>Included {resource.included_count ?? "—"}</span><span>Excluded {resource.excluded_count ?? "—"}</span></div>{resource.lastError || resource.last_error ? <p className="mt-1 break-words text-rose-600">{resource.lastError ?? resource.last_error}</p> : null}<div className="mt-2"><button disabled={!!busy || !event} onClick={() => void dispatch("event", "resource-refresh", entry.key, resource.endpoint)} className="rounded-md border border-[var(--fv-border)] px-2 py-1 text-[11px] font-semibold disabled:opacity-40">{event ? "Refresh resource" : "View only"}</button></div></div>)}</div>
      </Panel>; })}{!entries.length && <p className="rounded-xl border border-dashed border-[var(--fv-border)] p-8 text-center text-sm text-[var(--fv-muted)]">No registered objects match this filter.</p>}</div>
    </section>}

    {tab === "providers" && <section className="mt-6 space-y-4"><div><h2 className="text-xl font-bold">Provider health</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">Aggregated resource health across registered event and team objects.</p></div>{["The Blue Alliance", "Statbotics", "FRC Colors", "Other"].map((provider) => { const resources = allResources.filter((resource) => providerName(resource.endpoint) === provider); return <Panel key={provider}><div className="flex flex-wrap justify-between gap-2"><h3 className="font-bold">{provider}</h3><span className="text-xs text-[var(--fv-muted)]">{resources.length} resources</span></div><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{resources.map((resource) => <div key={resource.ownerType + resource.owner + resource.endpoint} className="rounded-lg border border-[var(--fv-border)] p-3 text-xs"><div className="font-semibold">{resource.ownerType} {resource.owner}</div><div className="mt-1">{endpointTitle(resource.endpoint)}</div><div className={"mt-1 font-bold " + tone(resource.status)}>{resource.status ?? "unknown"}</div><div className="mt-1 text-[var(--fv-muted)]">Records {resource.record_count ?? "—"} · Included {resource.included_count ?? "—"} · Fetched {age(resource.lastFetchedAt ?? resource.last_fetched_at)}</div>{resource.lastError || resource.last_error ? <p className="mt-1 text-rose-600">{resource.lastError ?? resource.last_error}</p> : null}</div>)}</div>{!resources.length && <p className="mt-2 text-xs text-[var(--fv-muted)]">No resources registered.</p>}</Panel>; })}</section>}

    {tab === "tasks" && <section className="mt-6"><h2 className="text-xl font-bold">Scheduled work</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">{allTasks.length} scheduled tasks across registered objects.</p><div className="mt-3 space-y-2">{allTasks.sort((a,b) => a.due_at-b.due_at).map((task) => <Panel key={task.ownerType + task.owner + task.endpoint}><div className="flex flex-wrap justify-between gap-2"><div className="font-semibold">{task.ownerType} {task.owner} · {endpointTitle(task.endpoint)}</div><span className={"text-xs font-bold " + (task.due_at <= Date.now() ? "text-amber-600" : "text-[var(--fv-muted)]")}>{task.due_at <= Date.now() ? "Due now" : "Scheduled"}</span></div><div className="mt-2 flex flex-wrap gap-4 text-xs text-[var(--fv-muted)]"><span>Due {dateTime(task.due_at)}</span><span>Attempts {task.attempts}</span><span>Interval {task.interval_ms == null ? "one-shot" : Math.round(task.interval_ms/60000) + "m"}</span><span>{task.retry_on_failure ? "Retry enabled" : "No retry"}</span></div></Panel>)}{!allTasks.length && <p className="rounded-xl border border-dashed border-[var(--fv-border)] p-8 text-center text-sm text-[var(--fv-muted)]">No scheduled tasks.</p>}</div></section>}

    {tab === "attention" && <section className="mt-6 space-y-4"><div><h2 className="text-xl font-bold">Needs attention</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">Stale, failed or unavailable provider resources and scheduler errors.</p></div>{(allResources.filter((resource) => ["stale", "failed", "unavailable"].includes(resource.status ?? "")).length === 0 && !overview?.scheduler.last_error && !overview?.scheduler.team_discovery_error) ? <Panel><p className="text-sm text-emerald-600">No reported resource or scheduler issues in the registered inventory.</p></Panel> : <><Panel><h3 className="font-bold">Scheduler errors</h3><p className="mt-2 text-xs text-rose-600">{overview?.scheduler.last_error ?? overview?.scheduler.team_discovery_error ?? "None"}</p>{overview?.scheduler.team_discovery_error && <p className="mt-1 text-xs text-rose-600">Team discovery: {overview.scheduler.team_discovery_error}</p>}</Panel>{allResources.filter((resource) => ["stale", "failed", "unavailable"].includes(resource.status ?? "")).map((resource) => <Panel key={resource.ownerType + resource.owner + resource.endpoint}><div className="flex flex-wrap justify-between gap-2"><div className="font-semibold">{resource.ownerType} {resource.owner} · {endpointTitle(resource.endpoint)}</div><span className={"text-xs font-bold " + tone(resource.status)}>{resource.status}</span></div><p className="mt-1 break-all font-mono text-[10px] text-[var(--fv-muted)]">{resource.endpoint}</p><p className="mt-1 text-xs text-[var(--fv-muted)]">Fetched {age(resource.lastFetchedAt ?? resource.last_fetched_at)} · Attempted {age(resource.lastAttemptAt ?? resource.last_attempt_at)} · HTTP {resource.lastHttpStatus ?? resource.http_status ?? "—"}</p>{(resource.lastError || resource.last_error) && <p className="mt-1 text-xs text-rose-600">{resource.lastError ?? resource.last_error}</p>}{resource.ownerType === "Event" ? <button disabled={!!busy} onClick={() => void dispatch("event", "resource-refresh", resource.owner, resource.endpoint)} className="mt-2 rounded-md border border-[var(--fv-border)] px-2 py-1 text-xs font-semibold disabled:opacity-40">Retry resource</button> : <button disabled={!!busy} onClick={() => void dispatch("team", "refresh", resource.owner)} className="mt-2 rounded-md border border-[var(--fv-border)] px-2 py-1 text-xs font-semibold disabled:opacity-40">Refresh team data</button>}</Panel>)}</>}</section>}

    {tab === "system" && <section className="mt-6 grid gap-4 lg:grid-cols-2"><Panel><h2 className="font-bold">Global scheduler</h2><p className="mt-1 text-sm text-[var(--fv-muted)]">Controls event discovery and lifecycle scheduling.</p><div className="mt-3 text-sm">Status: <strong className={overview?.scheduler.enabled ? "text-emerald-600" : "text-amber-600"}>{overview?.scheduler.enabled ? "Running" : "Stopped"}</strong></div><div className="mt-1 text-xs text-[var(--fv-muted)]">Last run {dateTime(overview?.scheduler.last_run_at)} · Next alarm {dateTime(overview?.scheduler.next_alarm_at)}</div><div className="mt-4 flex flex-wrap gap-2"><button disabled={!!busy || overview?.scheduler.enabled} onClick={() => void dispatch("system", "scheduler-start")} className="rounded-lg bg-[var(--fv-brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Start scheduler</button><button disabled={!!busy || !overview?.scheduler.enabled} onClick={() => void dispatch("system", "scheduler-stop")} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold disabled:opacity-40">Stop scheduler</button><button disabled={!!busy} onClick={() => void dispatch("system", "scheduler-run")} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold disabled:opacity-40">Run discovery now</button></div>{overview?.scheduler.last_error && <p className="mt-3 text-xs text-rose-600">Event discovery: {overview.scheduler.last_error}</p>}{overview?.scheduler.team_discovery_error && <p className="mt-1 text-xs text-rose-600">Team discovery: {overview.scheduler.team_discovery_error}</p>}</Panel><Panel><h2 className="font-bold">Multiplexer</h2><p className="mt-2 text-sm">{overview?.multiplexer?.connected_sockets ?? "Unavailable"} sockets · {overview?.multiplexer?.clients ?? 0} clients</p><div className="mt-3 space-y-1 text-xs text-[var(--fv-muted)]">{overview?.multiplexer?.subscriptions?.map((item) => <p key={item.topic}>{item.topic}: {item.clients} clients</p>)}</div></Panel><Panel><h2 className="font-bold">Runtime inventory</h2><div className="mt-2 space-y-1 text-sm"><p>{overview?.inventory.events ?? 0} registered event objects</p><p>{overview?.inventory.teams ?? 0} registered team objects</p><p>{overview?.truncated ? "Inventory is truncated at 250 objects per type." : "Inventory is within the current 250-object per-type cap."}</p></div></Panel></section>}

    <p className="mt-8 text-xs leading-5 text-[var(--fv-muted)]">Inventory covers objects registered through FieldView routes and scheduler discovery, not every Durable Object in the Cloudflare account. Mutating actions are authenticated and dispatched server-side. Provider refreshes may take time to complete; use Refresh to reload their latest state.</p>
  </div>;
}
