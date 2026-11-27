"use client";

import { useCallback, useEffect, useState } from "react";

type WorkflowType = "event-readiness" | "team-readiness";
type RunSummary = Record<string, number | string | null>;
type RunResult = {
  key: string;
  state_valid: boolean;
  refresh_required: boolean;
  refresh_dispatched?: boolean;
  stale_sources?: string[];
  stale_resources?: string[];
  error?: string;
};
type WorkflowRun = {
  workflow_id: string;
  workflow_type: WorkflowType;
  status: string;
  workflow_status?: string | null;
  year: number | null;
  started_at: number;
  completed_at?: number | null;
  total?: number;
  summary?: RunSummary | null;
  results?: RunResult[];
  error?: string | null;
};
type RunList = { runs: Array<Partial<WorkflowRun> & { workflow_id: string }>; total: number };

function timestamp(value?: number | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  }).format(new Date(value));
}
function label(type: WorkflowType) { return type === "event-readiness" ? "Event readiness" : "Team readiness"; }
function statusClass(status?: string) {
  if (status === "completed" || status === "complete") return "text-emerald-600";
  if (status === "completed_with_errors" || status === "failed" || status === "errored" || status === "terminated" || status === "cancelled") return "text-rose-600";
  if (status === "running" || status === "queued") return "text-amber-600";
  return "text-[var(--fv-muted)]";
}

export default function WorkflowRunsPanel({ authenticated, year, requestedType }: { authenticated: boolean; year: number; requestedType?: WorkflowType }) {
  const [type, setType] = useState<WorkflowType>("event-readiness");
  const [runs, setRuns] = useState<RunList>({ runs: [], total: 0 });
  const [selected, setSelected] = useState<WorkflowRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [weeklyBusy, setWeeklyBusy] = useState(false);
  const [weeklyMessage, setWeeklyMessage] = useState("");
  const [weeklyWorkflowId, setWeeklyWorkflowId] = useState<string | null>(null);
  const [weeklyWorkflowStatus, setWeeklyWorkflowStatus] = useState<string | null>(null);

  useEffect(() => {
    if (requestedType && requestedType !== type) {
      setType(requestedType);
      setSelected(null);
    }
  }, [requestedType, type]);

  const loadRuns = useCallback(async () => {
    if (!authenticated) return;
    const response = await fetch("/internal/admin/proxy?workflowRuns=" + type + "&limit=30", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Unable to load workflow history");
    setRuns(body as RunList);
  }, [authenticated, type]);

  const loadRun = useCallback(async (id: string) => {
    const params = new URLSearchParams({ workflowRuns: type, runId: id });
    const response = await fetch("/internal/admin/proxy?" + params, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Unable to load workflow result");
    setSelected(body as WorkflowRun);
  }, [authenticated, type]);

  useEffect(() => { void loadRuns().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [loadRuns]);

  // Keep the history visible without requiring a manual refresh. This also
  // discovers runs started by the parent Admin Operations controls.
  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(() => {
      void loadRuns().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [authenticated, loadRuns]);

  // Select the newest run automatically so its live status/report is visible
  // immediately after a run is started elsewhere in the admin panel.
  useEffect(() => {
    if (selected || runs.runs.length === 0) return;
    void loadRun(runs.runs[0]!.workflow_id).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [runs, selected, loadRun]);

  useEffect(() => {
    if (!selected || selected.workflow_type !== type || !["running", "queued"].includes(selected.workflow_status ?? selected.status)) return;
    const timer = window.setInterval(() => {
      void loadRun(selected.workflow_id).then(() => loadRuns()).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [selected, type, loadRun, loadRuns]);

  async function dispatch() {
    setBusy(true); setError("");
    try {
      if (!Number.isInteger(year) || year < 1992 || year > 2200) {
        throw new Error("Select a valid four-digit season year first.");
      }
      const response = await fetch("/internal/admin/proxy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowType: type, year }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to start readiness workflow");
      if (body.workflow_id) {
        await Promise.all([loadRuns(), loadRun(body.workflow_id)]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start workflow");
    } finally { setBusy(false); }
  }

  async function refreshWeeklyProjection() {
    setWeeklyBusy(true); setWeeklyMessage(""); setError("");
    try {
      const response = await fetch("/internal/admin/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowType: "events-this-week" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to refresh weekly event candidates");
      setWeeklyWorkflowId(typeof body.workflow_id === "string" ? body.workflow_id : null);
      setWeeklyWorkflowStatus("queued");
      setWeeklyMessage("Weekly event candidate refresh accepted. FieldView is rediscovering TBA events and will publish the new Monday–Sunday projection asynchronously.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to refresh weekly event candidates");
    } finally { setWeeklyBusy(false); }
  }

  const loadWeeklyProjectionStatus = useCallback(async () => {
    if (!authenticated || !weeklyWorkflowId) return;
    const params = new URLSearchParams({ weeklyProjectionRun: weeklyWorkflowId });
    const response = await fetch("/internal/admin/proxy?" + params, {
      cache: "no-store",
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Unable to read weekly projection status");
    setWeeklyWorkflowStatus(String(body.workflow_status ?? "unknown"));
  }, [authenticated, weeklyWorkflowId]);

  useEffect(() => {
    if (!weeklyWorkflowId || ["complete", "completed", "errored", "terminated"].includes(weeklyWorkflowStatus ?? "")) return;
    let active = true;
    const poll = async () => {
      try { if (active) await loadWeeklyProjectionStatus(); }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [weeklyWorkflowId, weeklyWorkflowStatus, loadWeeklyProjectionStatus]);

  const summary = selected?.summary ?? {};
  const isEvent = type === "event-readiness";
  const totalLabel = isEvent ? "Events" : "Teams";
  const total = summary[isEvent ? "events_total" : "teams_total"] ?? selected?.total ?? 0;
  const valid = summary[isEvent ? "events_state_valid" : "teams_state_valid"] ?? 0;
  const required = summary[isEvent ? "events_refresh_required" : "teams_refresh_required"] ?? 0;
  const failed = summary[isEvent ? "events_failed" : "teams_failed"] ?? 0;

  return (
    <section className="rounded-2xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-bold">Readiness workflows</h2><p className="mt-1 text-sm text-[var(--fv-muted)]">Inspect independent season-wide discovery and runtime coverage; live refresh dispatch is handled separately.</p></div>
        <button onClick={() => void loadRuns().catch((cause) => setError(String(cause)))} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm">Refresh history</button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {(["event-readiness", "team-readiness"] as WorkflowType[]).map((item) => (
          <button key={item} onClick={() => { setType(item); setSelected(null); }} className={"rounded-lg px-3 py-2 text-sm " + (type === item ? "bg-[var(--fv-brand)] text-white" : "border border-[var(--fv-border)]")}>{label(item)}</button>
        ))}
        <span className="text-sm text-[var(--fv-muted)]">Season {year || "—"}</span>
        <button disabled={weeklyBusy} onClick={() => void refreshWeeklyProjection()} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm disabled:opacity-50">{weeklyBusy ? "Refreshing…" : "Rebuild weekly event candidates"}</button>
        <button disabled={busy || !year} onClick={() => void dispatch()} className="ml-auto rounded-lg bg-[var(--fv-brand)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Starting…" : "Start " + label(type)}</button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p>}
      {weeklyMessage && <p role="status" className="mt-3 text-sm text-[var(--fv-muted)]">{weeklyMessage}{weeklyWorkflowStatus ? " Workflow status: " + weeklyWorkflowStatus + "." : ""}</p>}
      <div className="mt-4 grid grid-cols-1 gap-6">
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold">Execution history ({runs.total})</h3>
          <div className="space-y-2">
            {runs.runs.length === 0 && <p className="rounded-lg border border-dashed border-[var(--fv-border)] p-3 text-sm text-[var(--fv-muted)]">No {label(type).toLowerCase()} runs recorded yet.</p>}
            {runs.runs.map((run) => (
              <button key={run.workflow_id} onClick={() => void loadRun(run.workflow_id).catch((cause) => setError(String(cause)))} className={"block w-full rounded-lg border p-3 text-left " + (selected?.workflow_id === run.workflow_id ? "border-[var(--fv-brand)] bg-[var(--fv-surface)]" : "border-[var(--fv-border)]")}>
                <span className={"block text-sm font-semibold " + statusClass(run.workflow_status ?? run.status)}>{(run.workflow_status ?? run.status ?? "unknown").replaceAll("_", " ")}</span>
                <span className="mt-1 block text-xs text-[var(--fv-muted)]">{timestamp(run.started_at)} · {run.year ?? "season pending"}</span>
                <span className="mt-1 block break-all font-mono text-[11px] text-[var(--fv-muted)]">{run.workflow_id}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold">Execution report</h3>
          {!selected && <p className="rounded-lg border border-dashed border-[var(--fv-border)] p-4 text-sm text-[var(--fv-muted)]">Select a run to inspect its result. New runs appear here as soon as they are accepted.</p>}
          {selected && <>
            <div className="rounded-lg border border-[var(--fv-border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><strong>{label(type)} · {selected.year ?? "Resolving season"}</strong><span className={"text-sm font-semibold " + statusClass(selected.workflow_status ?? selected.status)}>{(selected.workflow_status ?? selected.status).replaceAll("_", " ")}</span></div>
              <p className="mt-1 break-all font-mono text-xs text-[var(--fv-muted)]">{selected.workflow_id}</p>
              <p className="mt-2 text-xs text-[var(--fv-muted)]">Started {timestamp(selected.started_at)} · Completed {timestamp(selected.completed_at)}</p>
              {["running", "queued"].includes(selected.workflow_status ?? selected.status) && <p className="mt-3 text-sm text-[var(--fv-muted)]">The workflow is still running. The dashboard checks its status periodically; the final report appears when execution completes.</p>}
              {selected.error && <p className="mt-3 whitespace-pre-wrap text-sm text-rose-600">{selected.error}</p>}
              {selected.summary && <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[ [totalLabel, total], ["Valid state", valid], ["Refresh required", required], ["Failed", failed] ].map(([name, value]) => <div key={String(name)} className="rounded-lg bg-[var(--fv-surface)] p-3"><p className="text-xs text-[var(--fv-muted)]">{name}</p><p className="mt-1 text-xl font-bold tabular-nums">{value}</p></div>)}
              </div>}
            </div>
            {selected.results && selected.results.length > 0 && <div className="mt-3 max-w-full overflow-x-auto rounded-lg border border-[var(--fv-border)]">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-[var(--fv-surface)]"><tr><th className="p-2">Entity</th><th className="p-2">State</th><th className="p-2">Refresh required</th><th className="p-2">Details</th></tr></thead>
                <tbody>{selected.results.map((item) => <tr key={item.key} className="border-t border-[var(--fv-border)]">
                  <td className="p-2 font-mono">{item.key}</td><td className="p-2">{item.state_valid ? "Valid" : "Missing / invalid"}</td><td className="p-2">{item.refresh_required ? (item.refresh_dispatched ? "Dispatched" : "Required") : "Not required"}</td>
                  <td className="max-w-[260px] whitespace-pre-wrap p-2">{item.error ?? ((item.stale_sources ?? item.stale_resources ?? []).join(", ") || "—")}</td>
                </tr>)}</tbody>
              </table>
            </div>}
          </>}
        </div>
      </div>
    </section>
  );
}
