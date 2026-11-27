"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { FieldViewTeamEventAnalytics } from "@fieldview/domain";

type AnalysisEvent = {
  event: { key: string; name: string; shortName: string | null; startDate: string };
  status: "ready" | "pending" | "unavailable";
  analytics: FieldViewTeamEventAnalytics | null;
};
type AnalysisResponse = {
  team: number;
  year: number;
  eventCount: number;
  analyzedEventCount: number;
  matchCount: number;
  matchesSeen: number;
  events: AnalysisEvent[];
  collection: { state: string; analyzedEvents: number; totalEvents: number; updatedAt: number };
};

const number = (value: number | null | undefined, digits = 1) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const signed = (value: number | null | undefined, digits = 1) =>
  typeof value === "number" && Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(digits)}` : "—";

export default function TeamProfileTabs({
  teamNumber,
  year,
  results,
}: {
  teamNumber: number;
  year: number;
  results: ReactNode;
}) {
  const [tab, setTab] = useState<"results" | "analysis">("results");
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (tab !== "analysis" || (data && data.team === teamNumber && data.year === year)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const runtimeOrigin = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
    if (!runtimeOrigin) {
      setError("FieldView runtime is not configured");
      setLoading(false);
      return;
    }
    const url = new URL(`/teams/frc${teamNumber}/season-analytics?year=${year}`, runtimeOrigin);
    fetch(url, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(typeof body?.error === "string" ? body.error : "Team analysis is unavailable");
        }
        return response.json() as Promise<AnalysisResponse>;
      })
      .then((value) => { if (!cancelled) setData(value); })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Team analysis is unavailable");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab, teamNumber, year, data, retry]);

  return (
    <section className="mt-8">
      <div className="mb-5 flex gap-2 border-b border-[var(--fv-border)]" role="tablist" aria-label="Team profile sections">
        <button type="button" role="tab" aria-selected={tab === "results"} onClick={() => setTab("results")}
          className={`border-b-2 px-4 py-3 text-sm font-semibold ${tab === "results" ? "border-[var(--fv-brand)] text-[var(--fv-brand-strong)]" : "border-transparent text-[var(--fv-muted)] hover:text-[var(--fv-text)]"}`}>
          Results
        </button>
        <button type="button" role="tab" aria-selected={tab === "analysis"} onClick={() => setTab("analysis")}
          className={`border-b-2 px-4 py-3 text-sm font-semibold ${tab === "analysis" ? "border-[var(--fv-brand)] text-[var(--fv-brand-strong)]" : "border-transparent text-[var(--fv-muted)] hover:text-[var(--fv-text)]"}`}>
          Team Analysis
        </button>
      </div>
      {tab === "results" ? (
        <div role="tabpanel">{results}</div>
      ) : (
        <div role="tabpanel" className="space-y-5">
          {loading && <div className="rounded-xl border border-[var(--fv-border)] p-5 text-sm text-[var(--fv-muted)]">Loading canonical team analysis…</div>}
          {error && (
            <div className="rounded-xl border border-[var(--fv-border)] p-5 text-sm text-[var(--fv-muted)]">
              <p>{error}</p>
              <button type="button" className="mt-3 font-semibold text-[var(--fv-brand)]" onClick={() => { setData(null); setError(null); setRetry((value) => value + 1); }}>Try again</button>
            </div>
          )}
          {data && data.team === teamNumber && data.year === year && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-[var(--fv-muted)]">
                  {data.analyzedEventCount} of {data.eventCount} events analyzed · {data.matchCount} completed matches with team analytics
                </p>
                <div className="flex items-center gap-3">
                  <span className="rounded-full border border-[var(--fv-border)] px-2.5 py-1 text-xs font-semibold text-[var(--fv-muted)]">{data.collection.state}</span>
                  <button type="button" className="text-sm font-semibold text-[var(--fv-brand)]" onClick={() => { setData(null); setRetry((value) => value + 1); }}>Refresh analysis</button>
                </div>
              </div>
              {data.events.length === 0 ? (
                <div className="rounded-xl border border-[var(--fv-border)] p-5 text-sm text-[var(--fv-muted)]">No official events were found for {year}.</div>
              ) : (
                <div className="space-y-4">
                  {data.events.map(({ event, status, analytics }) => {
                    const performance = analytics?.performance;
                    return (
                      <article key={event.key} className="overflow-hidden rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)]">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--fv-border)] px-4 py-3">
                          <div>
                            <h3 className="font-bold text-[var(--fv-text)]">{event.name}</h3>
                            <p className="text-xs text-[var(--fv-muted)]">{event.startDate}</p>
                          </div>
                          <span className="text-xs font-semibold capitalize text-[var(--fv-muted)]">{status === "ready" ? "Analysis ready" : status === "pending" ? "Awaiting runtime analytics" : "Event data unavailable"}</span>
                        </div>
                        {!analytics ? (
                          <p className="px-4 py-4 text-sm text-[var(--fv-muted)]">This event has not published team analytics yet. Its canonical event data remains separate from this analysis.</p>
                        ) : (
                          <div className="space-y-4 p-4">
                            {analytics.summary && analytics.summary.length > 0 && (
                              <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--fv-text)]">
                                {analytics.summary.map((item, index) => <li key={index}>{item}</li>)}
                              </ul>
                            )}
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                              <Metric label="EPA" value={number(performance?.epa)} />
                              <Metric label="EPA change" value={signed(performance?.epa_change)} />
                              <Metric label="Record" value={performance ? `${performance.wins ?? "—"}–${performance.losses ?? "—"}–${performance.ties ?? "—"}` : "—"} />
                              <Metric label="Completed" value={performance ? `${performance.completed_matches}/${performance.matches_seen}` : "—"} />
                            </div>
                            {analytics.season_comparison && (
                              <div className="rounded-lg border border-[var(--fv-border)] p-3 text-sm">
                                <p className="font-semibold text-[var(--fv-text)]">Compared with previous event</p>
                                <p className="mt-1 text-[var(--fv-muted)]">{analytics.season_comparison.prior_event.event_name}: {number(analytics.season_comparison.prior_epa)} → {number(analytics.season_comparison.current_epa)} EPA ({signed(analytics.season_comparison.change)})</p>
                                <p className="mt-1 text-xs text-[var(--fv-muted)]">Change rank {analytics.season_comparison.comparison_rank} of {analytics.season_comparison.comparison_size} eligible teams</p>
                              </div>
                            )}
                            {analytics.peer_performance && (
                              <p className="text-sm text-[var(--fv-muted)]">Alliance residual comparison: {analytics.peer_performance.interpretation.replaceAll("-", " ")} · {analytics.peer_performance.team_match_count} team matches · {analytics.peer_performance.peer_alliance_count} peer alliance observations</p>
                            )}
                            {analytics.findings.length > 0 && (
                              <div>
                                <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--fv-muted)]">Review findings</h4>
                                <ul className="space-y-2">
                                  {analytics.findings.map((finding) => (
                                    <li key={finding.finding_key} className="rounded-lg border border-[var(--fv-border)] p-3">
                                      <p className="text-sm font-semibold text-[var(--fv-text)]">{finding.title}</p>
                                      <p className="mt-1 text-sm text-[var(--fv-muted)]">{finding.summary}</p>
                                      <p className="mt-1 text-xs text-[var(--fv-muted)]">{finding.suggested_action}</p>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {analytics.review_matches && analytics.review_matches.length > 0 && (
                              <div>
                                <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--fv-muted)]">Matches to review</h4>
                                <div className="overflow-x-auto">
                                  <table className="w-full min-w-[560px] text-left text-sm">
                                    <thead className="text-xs text-[var(--fv-muted)]"><tr><th className="py-2">Match</th><th>Alliance</th><th>Score</th><th>Residual</th><th>EPA change</th><th>Review note</th></tr></thead>
                                    <tbody>
                                      {analytics.review_matches.map((match) => (
                                        <tr key={match.match_key} className="border-t border-[var(--fv-border)]">
                                          <td className="py-2 font-mono">{match.match_label}</td>
                                          <td className="capitalize">{match.alliance}</td>
                                          <td>{match.actual_score ?? "—"} / {match.predicted_score ?? "—"}</td>
                                          <td>{signed(match.score_residual)}</td>
                                          <td>{signed(match.epa_change)}</td>
                                          <td className="text-xs text-[var(--fv-muted)]">{match.reasons.join(" ") || "Scout review"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-[var(--fv-border)] p-3"><p className="text-xs text-[var(--fv-muted)]">{label}</p><p className="mt-1 text-lg font-bold tabular-nums text-[var(--fv-text)]">{value}</p></div>;
}
