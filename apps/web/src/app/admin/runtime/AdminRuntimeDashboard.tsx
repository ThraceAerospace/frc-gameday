"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Endpoint = {
  endpoint: string;
  status?: string;
  revision?: number;
  lastFetchedAt?: number | null;
  lastAttemptAt?: number | null;
  last_fetched_at?: number | null;
  last_attempt_at?: number | null;
  lastError?: string | null;
  last_error?: string | null;
  lastHttpStatus?: number | null;
  http_status?: number | null;
  expiresAt?: number | null;
};
type Task = {
  endpoint: string;
  due_at: number;
  interval_ms: number | null;
  attempts: number;
  retry_on_failure?: boolean;
  authoritative_refetch_at?: number;
};
type RuntimeEntry = {
  key: string;
  status: number;
  error?: string;
  state?: {
    event_key?: string;
    team_key?: string;
    lifecycle?: { completed_until?: number | null };
    polling?: Task[];
    endpoints?: Record<string, Endpoint> | Endpoint[];
    diagnostics?: Array<{ endpoint: string; http_status: number | null; last_error: string | null }>;
  } | null;
};
type Overview = {
  generated_at: string;
  scheduler: { enabled: boolean; last_run_at: number | null; next_alarm_at: number | null; last_error: string | null; team_discovery_error: string | null };
  events: RuntimeEntry[];
  teams: RuntimeEntry[];
  multiplexer: { connected_sockets: number | null; clients: number; subscriptions: Array<{ topic: string; clients: number }> } | null;
  inventory: { events: number; teams: number };
  truncated: boolean;
  error?: string;
};

function dateTime(value?: number | null) {
  if (value == null) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC", timeZoneName: "short" }).format(new Date(value));
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
  if (Array.isArray(values)) {\n    const diagnostics = new Map((entry.state?.diagnostics ?? []).map((item) => [item.endpoint, item]));\n    return values.map((value) => ({ ...value, ...(diagnostics.get(value.endpoint) ?? {}) }));\n  }
  return Object.entries(values ?? {}).map(([key, value]) => ({
    ...value,
    endpoint: value.endpoint ?? key.replace(/^endpoint:/, ""),
  }));
}
function statusTone(status?: string) {
  if (status === "available" || status === "fresh" || status === "ok") return "text-emerald-600";
  if (status === "stale" || status === "unknown") return "text-amber-600";
  if (status === "failed" || status === "unavailable" || status === "error") return "text-rose-600";
  return "text-[var(--fv-muted)]";
}

export default function AdminRuntimeDashboard() {
  const [token, setToken] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "events" | "teams">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!token) return;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/admin/runtime", {
        headers: { Authorization: "Bearer " + token },
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Admin request failed (" + response.status + ")");
      setOverview(body as Overview);
      setAuthenticated(true);
      setError("");
      setLastUpdated(Date.now());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to load runtime state";
      setError(message);
      if (!quiet) setAuthenticated(false);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!authenticated || !token) return;
    const timer = window.setInterval(() => void refresh(true), 10_000);
    return () => window.clearInterval(timer);
  }, [authenticated, token, refresh]);

  const allEntries = useMemo(() => [
    ...(kind !== "teams" ? (overview?.events ?? []).map((entry) => ({ ...entry, type: "Event" })) : []),
    ...(kind !== "events" ? (overview?.teams ?? []).map((entry) => ({ ...entry, type: "Team" })) : []),
  ].filter((entry) => (entry.key + " " + entry.type).toLowerCase().includes(filter.toLowerCase())), [overview, kind, filter]);

  const counts = useMemo(() => {
    const entries = [...(overview?.events ?? []), ...(overview?.teams ?? [])];
    let tasks = 0, failed = 0, stale = 0, pending = 0;
    for (const entry of entries) {
      if (!entry.state) { failed++; continue; }
      for (const endpoint of endpointRows(entry)) {
        if (endpoint.status === "failed" || endpoint.status === "unavailable") failed++;
        if (endpoint.status === "stale") stale++;
      }
      const now = Date.now();
      for (const task of entry.state.polling ?? []) {
        tasks++;
        if (task.due_at <= now) pending++;
      }
    }
    return { objects: entries.length, tasks, failed, stale, pending };
  }, [overview]);

  if (!authenticated) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-5 py-12">
        <div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FieldView operations</div>
        <h1 className="text-3xl font-bold tracking-tight">Runtime admin</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--fv-muted)]">Sign in with the dashboard access token to inspect Durable Objects, ingestion tasks, and the event scheduler.</p>
        <form className="mt-7 space-y-3" onSubmit={(event) => { event.preventDefault(); void refresh(); }}>
          <label htmlFor="admin-token" className="block text-sm font-semibold">Dashboard access token</label>
          <input id="admin-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} className="w-full rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-4 py-3 text-sm outline-none focus:border-[var(--fv-brand)]" placeholder="Enter admin access token" />
          {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
          <button disabled={!token || loading} className="w-full rounded-xl bg-[var(--fv-brand)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{loading ? "Connecting…" : "Open dashboard"}</button>
        </form>
        <p className="mt-5 text-xs leading-5 text-[var(--fv-muted)]">The dashboard token is separate from the Worker service token. The service token remains server-side and is never sent to this browser.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-7 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FieldView operations</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Runtime overview</h1>
          <p className="mt-1 text-sm text-[var(--fv-muted)]">Durable Object inventory, provider resource health, and scheduled work.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--fv-muted)]">Updated {lastUpdated ? age(lastUpdated) : "—"} · auto-refresh 10s</span>
          <button onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold hover:border-[var(--fv-brand)]">{loading ? "Refreshing…" : "Refresh"}</button>
          <button onClick={() => { setAuthenticated(false); setOverview(null); setToken(""); }} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold">Sign out</button>
        </div>
      </div>

      {error && <div role="alert" className="mt-4 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
      {overview?.truncated && <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">Inventory is capped at 250 event and 250 team objects per refresh.</div>}

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ["Durable Objects", counts.objects.toString()],
          ["Scheduled tasks", counts.tasks.toString()],
          ["Due now", counts.pending.toString()],
          ["Stale resources", counts.stale.toString()],
          ["Failed / unavailable", counts.failed.toString()],
        ].map(([label, value]) => <div key={label} className="rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4"><div className="text-xs font-medium text-[var(--fv-muted)]">{label}</div><div className="mt-1 text-2xl font-bold tabular-nums">{value}</div></div>)}
      </div>

      <section className="mt-6 rounded-2xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-bold">Global event scheduler</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">Discovery and event lifecycle coordinator</p></div>
          <span className={overview?.scheduler.enabled ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800" : "rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800"}>{overview?.scheduler.enabled ? "Running" : "Stopped"}</span>
        </div>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><div className="text-xs text-[var(--fv-muted)]">Last scheduler run (UTC)</div><div className="mt-1 font-medium">{dateTime(overview?.scheduler.last_run_at)}</div></div>\n          <div><div className="text-xs text-[var(--fv-muted)]">Next scheduler alarm (UTC)</div><div className="mt-1 font-medium">{dateTime(overview?.scheduler.next_alarm_at)}</div></div>
          <div><div className="text-xs text-[var(--fv-muted)]">Registered event objects</div><div className="mt-1 font-medium tabular-nums">{overview?.inventory.events ?? 0}</div></div>
          <div><div className="text-xs text-[var(--fv-muted)]">Registered team objects</div><div className="mt-1 font-medium tabular-nums">{overview?.inventory.teams ?? 0}</div></div>
          <div><div className="text-xs text-[var(--fv-muted)]">Multiplexer connections</div><div className="mt-1 font-medium tabular-nums">{overview?.multiplexer?.connected_sockets ?? "Unavailable"} · {overview?.multiplexer?.clients ?? 0} clients</div></div>
        </div>
        {(overview?.scheduler.last_error || overview?.scheduler.team_discovery_error) && <div className="mt-4 space-y-1 rounded-lg bg-rose-50 p-3 text-xs text-rose-800"><div className="font-bold">Scheduler errors</div>{overview.scheduler.last_error && <p>Event discovery: {overview.scheduler.last_error}</p>}{overview.scheduler.team_discovery_error && <p>Team discovery: {overview.scheduler.team_discovery_error}</p>}</div>}
        {!!overview?.multiplexer?.subscriptions?.length && <div className="mt-4 flex flex-wrap gap-2">{overview.multiplexer.subscriptions.map((item) => <span key={item.topic} className="rounded-lg bg-[var(--fv-brand-soft)] px-2.5 py-1 text-xs text-[var(--fv-text)]">{item.topic}: {item.clients} clients</span>)}</div>}
      </section>

      <section className="mt-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-xl font-bold">Durable Object inventory</h2><p className="mt-1 text-xs text-[var(--fv-muted)]">Registered instances and their resource-level state</p></div>
          <div className="flex flex-wrap gap-2">
            <input aria-label="Filter objects" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by key…" className="w-44 rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-3 py-2 text-sm" />
            <select aria-label="Object type" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="rounded-lg border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] px-3 py-2 text-sm"><option value="all">All objects</option><option value="events">EventRuntime</option><option value="teams">TeamRuntime</option></select>
          </div>
        </div>

        <div className="mt-3 space-y-3">
          {allEntries.map((entry) => {
            const endpoints = endpointRows(entry);
            const tasks = entry.state?.polling ?? [];
            const problems = endpoints.filter((endpoint) => ["failed", "unavailable", "stale"].includes(endpoint.status ?? ""));
            const id = entry.type + ":" + entry.key;
            const isExpanded = expanded === id;
            return <article key={id} className="overflow-hidden rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)]">
              <button onClick={() => setExpanded(isExpanded ? null : id)} aria-expanded={isExpanded} className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[var(--fv-brand-soft)]/40">
                <div className="min-w-0"><div className="flex items-center gap-2"><span className="text-xs font-bold uppercase tracking-wide text-[var(--fv-muted)]">{entry.type}Runtime</span><span className="truncate font-semibold">{entry.key}</span></div><div className="mt-1 text-xs text-[var(--fv-muted)]">{endpoints.length} resources · {tasks.length} scheduled tasks · {problems.length} stale/failed</div></div>
                <div className="flex items-center gap-3 text-xs"><span className={entry.status === 200 ? "font-semibold text-emerald-600" : "font-semibold text-rose-600"}>{entry.status === 200 ? "Reachable" : "HTTP " + entry.status}</span><span className="text-[var(--fv-muted)]">{isExpanded ? "Hide details −" : "Details +"}</span></div>
              </button>
              {isExpanded && <div className="border-t border-[var(--fv-border)] p-4">
                {entry.error && <p className="mb-3 text-sm text-rose-600">{entry.error}</p>}
                <div className="grid gap-4 lg:grid-cols-2">
                  <div><h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--fv-muted)]">Resources</h3><div className="space-y-2">{endpoints.map((endpoint) => {
                    const last = endpoint.lastFetchedAt ?? endpoint.last_fetched_at ?? null;
                    const status = endpoint.status ?? "unknown";
                    return <div key={endpoint.endpoint} className="rounded-lg border border-[var(--fv-border)] p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all font-medium">{endpoint.endpoint}</span><span className={"font-bold " + statusTone(status)}>{status}</span></div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[var(--fv-muted)]"><span>Revision {endpoint.revision ?? "—"}</span><span>Fetched {age(last)}</span><span>HTTP {endpoint.lastHttpStatus ?? endpoint.http_status ?? "—"}</span></div>
                      {(endpoint.lastError || endpoint.last_error) && <p className="mt-1 break-words text-rose-600">{endpoint.lastError ?? endpoint.last_error}</p>}
                    </div>;
                  })}{!endpoints.length && <p className="text-xs text-[var(--fv-muted)]">No resource state recorded yet.</p>}</div></div>
                  <div><h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--fv-muted)]">Scheduled tasks</h3><div className="space-y-2">{tasks.map((task) => <div key={task.endpoint} className="rounded-lg border border-[var(--fv-border)] p-3 text-xs"><div className="break-all font-medium">{task.endpoint}</div><div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[var(--fv-muted)]"><span>Due {dateTime(task.due_at)}</span><span>{task.due_at <= Date.now() ? "Due now" : "Scheduled"}</span><span>Attempts {task.attempts}</span><span>Interval {task.interval_ms == null ? "one-shot" : Math.round(task.interval_ms / 60000) + "m"}</span></div>{task.authoritative_refetch_at && <div className="mt-1 text-[var(--fv-muted)]">Authoritative refetch {dateTime(task.authoritative_refetch_at)}</div>}</div>)}{!tasks.length && <p className="text-xs text-[var(--fv-muted)]">No pending scheduled tasks.</p>}</div></div>
                </div>
              </div>}
            </article>;
          })}
          {!allEntries.length && <div className="rounded-xl border border-dashed border-[var(--fv-border)] p-8 text-center text-sm text-[var(--fv-muted)]">No registered objects match this filter.</div>}
        </div>
      </section>
      <p className="mt-6 text-xs leading-5 text-[var(--fv-muted)]">Inventory covers Durable Objects registered through FieldView routes and scheduler discovery. It is not a Cloudflare account-wide platform inventory of objects never touched by this application.</p>
    </div>
  );
}
