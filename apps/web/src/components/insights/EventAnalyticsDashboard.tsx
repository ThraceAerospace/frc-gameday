"use client";

import { useState } from "react";
import type {
  FieldViewAnalyticsFinding,
  FieldViewEventAnalytics,
  FieldViewMatch,
  FieldViewMetricResult,
  FieldViewTeamState,
} from "@fieldview/domain";

type Tab = "overview" | "teams" | "matches" | "findings";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "teams", label: "Teams" },
  { id: "matches", label: "Match review" },
  { id: "findings", label: "Review findings" },
];

function formatValue(metric: FieldViewMetricResult): string {
  if (metric.status !== "available") return "—";
  if (metric.unit === "ratio") {
    return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(metric.value);
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(metric.value);
}

function MetricCard({ metric }: { metric: FieldViewMetricResult }) {
  return (
    <article className="min-w-0 rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--fv-muted)]">{metric.metric_key.replaceAll("-", " ")}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-[var(--fv-text)]">{formatValue(metric)} <span className="text-xs font-medium text-[var(--fv-muted)]">{metric.unit === "ratio" ? "" : metric.unit}</span></p>
      <p className="mt-1 text-xs text-[var(--fv-muted)]">{metric.sample_size} observations · {metric.population.eligible_count}/{metric.population.total_count} eligible</p>
      {metric.comparison ? <p className="mt-1 text-xs text-[var(--fv-muted)]">{metric.comparison.rank_position === null ? "Unranked" : `Rank ${metric.comparison.rank_position}`} of {metric.comparison.population.eligible_count} · {metric.comparison.percentile === null ? "percentile unavailable" : `${metric.comparison.percentile.toFixed(1)}th percentile`}</p> : null}
      {metric.baseline ? <p className="mt-1 text-xs text-[var(--fv-muted)]">Baseline: {metric.baseline.event_name} · {metric.baseline.value.toFixed(2)} {metric.unit}</p> : null}
      {metric.limitations.length ? <p className="mt-2 text-xs leading-5 text-[var(--fv-muted)]">{metric.limitations.join(" ")}</p> : null}
    </article>
  );
}

function FindingCard({ finding }: { finding: FieldViewAnalyticsFinding }) {
  return (
    <article key={finding.finding_key} className="rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${finding.severity === "high" ? "bg-red-500/10 text-red-600" : finding.severity === "medium" ? "bg-amber-500/10 text-amber-700" : "bg-[var(--fv-surface)] text-[var(--fv-muted)]"}`}>{finding.severity}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--fv-muted)]">{finding.scope} · {finding.category}</span>
      </div>
      <h3 className="mt-2 font-semibold text-[var(--fv-text)]">{finding.title}</h3>
      <p className="mt-1 text-sm leading-6 text-[var(--fv-muted)]">{finding.summary}</p>
      {finding.evidence.length ? <ul className="mt-3 space-y-1 text-xs text-[var(--fv-muted)]">{finding.evidence.map((item) => <li key={item.evidence_key}>{item.label}: {item.value === null ? "descriptive evidence" : `${item.value} ${item.unit}`}{item.threshold === undefined || item.threshold === null ? "" : ` (threshold ${item.threshold})`}</li>)}</ul> : null}
      <p className="mt-3 text-xs font-medium text-[var(--fv-text)]">Suggested review: {finding.suggested_action}</p>
      {finding.limitations.length ? <p className="mt-2 text-xs text-[var(--fv-muted)]">{finding.limitations.join(" ")}</p> : null}
    </article>
  );
}

export default function EventAnalyticsDashboard({
  eventKey,
  eventName,
  eventTimezone,
  analytics,
  teamStates,
  matches,
  loading,
  websocketStatus,
}: {
  eventKey: string;
  eventName: string;
  eventTimezone?: string;
  analytics: FieldViewEventAnalytics | null | undefined;
  teamStates: FieldViewTeamState[] | null | undefined;
  matches: FieldViewMatch[] | null | undefined;
  loading: boolean;
  websocketStatus: "connected" | "disconnected" | "connecting";
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const teams = (teamStates ?? []).filter((team) => team.analytics);
  const findings = [
    ...(analytics?.findings ?? []),
    ...teams.flatMap((team) => team.analytics?.findings ?? []),
  ];
  const flaggedMatches = (matches ?? []).filter((match) =>
    Boolean(match.flags?.review_flags.length || match.flags?.alliances.red.length || match.flags?.alliances.blue.length),
  );

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--fv-brand)]">FieldView · Event analytics</p>
          <h2 className="mt-1 text-2xl font-black tracking-tight text-[var(--fv-text)]">{eventName}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fv-muted)]">Server-calculated event, team, and match analysis. Findings are review prompts based on the evidence shown; they do not establish robot-level causation.</p>
          <p className="mt-2 text-xs text-[var(--fv-muted)]">Runtime: {websocketStatus === "connected" ? "connected" : websocketStatus === "connecting" ? "connecting" : "disconnected"}</p>
        </div>
        <a href={`/gameday?event=${encodeURIComponent(eventKey)}`} className="rounded-lg border border-[var(--fv-border)] px-3 py-2 text-sm font-semibold text-[var(--fv-text)] hover:bg-[var(--fv-surface)]">Open Gameday</a>
      </header>

      <nav aria-label="Analytics panels" className="mt-6 flex gap-2 overflow-x-auto border-b border-[var(--fv-border)]">
        {TABS.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-current={tab === item.id ? "page" : undefined} className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm font-semibold ${tab === item.id ? "border-[var(--fv-brand)] text-[var(--fv-brand-strong)]" : "border-transparent text-[var(--fv-muted)] hover:text-[var(--fv-text)]"}`}>{item.label}</button>)}
      </nav>

      {loading ? <p className="py-8 text-sm text-[var(--fv-muted)]">Waiting for the canonical event snapshot…</p> : null}
      {!loading && analytics === undefined ? <p className="mt-5 rounded-xl border border-[var(--fv-border)] p-5 text-sm text-[var(--fv-muted)]">Analytics have not been published for this event yet. The runtime will publish them after its calculation job completes.</p> : null}
      {!loading && analytics === null ? <p className="mt-5 rounded-xl border border-[var(--fv-border)] p-5 text-sm text-[var(--fv-muted)]">The runtime reports event analytics as unavailable.</p> : null}

      {tab === "overview" && analytics ? (
        <div className="mt-5 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{analytics.metrics.map((metric) => <MetricCard key={metric.metric_key} metric={metric} />)}</div>
          <AuditSummary audit={analytics.audit} eventTimezone={eventTimezone} />
          <div><h3 className="mb-3 text-lg font-bold text-[var(--fv-text)]">Event findings</h3>{analytics.findings.length ? <div className="grid gap-3 lg:grid-cols-2">{analytics.findings.map((finding) => <FindingCard key={finding.finding_key} finding={finding} />)}</div> : <p className="text-sm text-[var(--fv-muted)]">No event-level review findings were produced.</p>}</div>
        </div>
      ) : null}

      {tab === "teams" ? (
        <div className="mt-5 space-y-4">
          {teamStates === undefined ? <p className="text-sm text-[var(--fv-muted)]">Team analytics are not present in the current snapshot.</p> : teamStates === null ? <p className="text-sm text-[var(--fv-muted)]">Team state is explicitly unavailable.</p> : teams.length === 0 ? <p className="text-sm text-[var(--fv-muted)]">No team analytics have been published yet.</p> : teams.map((team) => (
            <article key={team.team_key} className="rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4">
              <h3 className="font-bold text-[var(--fv-text)]"><a className="hover:underline" href={`/team/${team.team?.team_number ?? team.team_key}`}>{team.team?.team_number ?? team.team_key} · {team.team?.nickname ?? team.team?.name ?? "Team"}</a></h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{team.analytics!.metrics.map((metric) => <MetricCard key={metric.metric_key} metric={metric} />)}</div>
              {team.analytics!.findings.length ? <div className="mt-4 grid gap-3 lg:grid-cols-2">{team.analytics!.findings.map((finding) => <FindingCard key={finding.finding_key} finding={finding} />)}</div> : null}
              <AuditSummary audit={team.analytics!.audit} eventTimezone={eventTimezone} />
            </article>
          ))}
        </div>
      ) : null}

      {tab === "matches" ? (
        <div className="mt-5 space-y-3">
          {matches === undefined ? <p className="text-sm text-[var(--fv-muted)]">Match data is not present in the current snapshot.</p> : matches === null ? <p className="text-sm text-[var(--fv-muted)]">Match data is explicitly unavailable.</p> : flaggedMatches.length === 0 ? <p className="text-sm text-[var(--fv-muted)]">No match review flags are currently published.</p> : flaggedMatches.map((match) => (
            <article key={match.key} className="rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-[var(--fv-text)]"><a className="hover:underline" href={`/event/${eventKey}/match/${match.key}`}>{match.key}</a></h3><span className="text-xs text-[var(--fv-muted)]">{match.flags?.winner ? `Winner: ${match.flags.winner}` : "Winner unavailable"}</span></div>
              {match.flags?.review_flags.length ? <p className="mt-2 text-sm text-[var(--fv-text)]">{match.flags.review_flags.join(" · ")}</p> : null}
              <div className="mt-2 grid gap-2 sm:grid-cols-2">{(["red", "blue"] as const).map((color) => <div key={color} className="rounded-lg bg-[var(--fv-surface)] p-3"><p className="text-xs font-bold uppercase text-[var(--fv-muted)]">{color} alliance</p><p className="mt-1 text-sm text-[var(--fv-text)]">{match.flags?.alliances[color].length ? match.flags.alliances[color].map((flag) => flag.type.replaceAll("-", " ")).join(" · ") : "No alliance flags"}</p></div>)}</div>
              {match.analysis ? <p className="mt-2 text-xs text-[var(--fv-muted)]">Score residual · Red {match.analysis.score.red.delta ?? "—"} / Blue {match.analysis.score.blue.delta ?? "—"} points</p> : null}
            </article>
          ))}
        </div>
      ) : null}

      {tab === "findings" ? <div className="mt-5">{findings.length ? <div className="grid gap-3 lg:grid-cols-2">{findings.map((finding) => <FindingCard key={finding.finding_key} finding={finding} />)}</div> : <p className="text-sm text-[var(--fv-muted)]">No review findings are currently published.</p>}</div> : null}
    </section>
  );
}

function AuditSummary({ audit, eventTimezone }: { audit?: { calculation_id: string; engine_version: string; calculated_at: number; input_digest: string; inputs: { input_key: string; provider: string; resource: string; status: string; included_count: number; excluded_count: number }[]; definition_versions: { definition_key: string; version: string }[]; warnings: string[] }; eventTimezone?: string }) {
  if (!audit) return null;
  const calculatedAt = eventTimezone
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: eventTimezone }).format(new Date(audit.calculated_at))
    : "event time zone unavailable";
  return (
    <details className="rounded-xl border border-[var(--fv-border)] p-4">
      <summary className="cursor-pointer text-sm font-semibold text-[var(--fv-text)]">Calculation audit · {calculatedAt}</summary>
      <div className="mt-3 space-y-2 text-xs text-[var(--fv-muted)]">
        <p>Engine {audit.engine_version} · Calculation {audit.calculation_id}</p>
        <p>Input digest: <code className="break-all">{audit.input_digest}</code></p>
        <p>Definitions: {audit.definition_versions.map((item) => `${item.definition_key}@${item.version}`).join(", ")}</p>
        {audit.inputs.map((input) => <p key={input.input_key}>{input.provider}/{input.resource}: {input.status} · {input.included_count} included · {input.excluded_count} excluded</p>)}
        {audit.warnings.map((warning) => <p key={warning} className="text-amber-700">{warning}</p>)}
      </div>
    </details>
  );
}
