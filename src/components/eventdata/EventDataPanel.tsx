"use client";

import { useMemo } from "react";
import { useEventState } from "@/lib/events";
import { formatTeamNumber } from "@/lib/tba/formatters";
import type { EventStateSnapshot } from "@/lib/events/EventState";

type EventDataPanelProps = {
  eventKey: string;
  className?: string;
  title?: string;
};

type EventDataPanelContentProps = EventDataPanelProps & {
  snapshot: EventStateSnapshot;
};

/** Pure presentation of an event performance snapshot, reusable by local and remote surfaces. */
export function EventDataPanelContent({
  eventKey,
  className = "",
  title = "Event Performance",
  snapshot,
}: EventDataPanelContentProps) {
  const { event, teams, oprs, loading, error } = snapshot;

  const rows = useMemo(() => {
    if (!oprs?.oprs) return [];

    const names = new Map(
      teams.map((team) => [
        team.key,
        team.nickname ?? team.name ?? team.key,
      ] as const),
    );

    return Object.entries(oprs.oprs)
      .map(([teamKey, opr]) => ({
        teamKey,
        name: names.get(teamKey) ?? teamKey,
        opr: typeof opr === "number" ? opr : null,
        dpr: typeof oprs.dprs?.[teamKey] === "number" ? oprs.dprs[teamKey] : null,
        ccwm: typeof oprs.ccwms?.[teamKey] === "number" ? oprs.ccwms[teamKey] : null,
      }))
      .sort((a, b) => (b.opr ?? -Infinity) - (a.opr ?? -Infinity));
  }, [oprs, teams]);

  return (
    <section className={`flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-950 text-white ${className}`}>
      <header className="shrink-0 border-b border-white/10 bg-neutral-900/80 px-4 py-3">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <p className="mt-1 truncate text-xs text-neutral-500">{event?.name ?? eventKey} · TBA event performance</p>
      </header>

      {error ? (
        <div className="m-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-200">
          Event data could not be loaded.
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length > 0 ? (
          <table className="w-full border-collapse text-left text-xs tabular-nums">
            <thead className="sticky top-0 z-10 bg-neutral-900 text-[10px] uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-3 py-2 text-right font-medium">Rank</th>
                <th className="px-3 py-2 font-medium">Team</th>
                <th className="px-3 py-2 text-right font-medium">OPR</th>
                <th className="px-3 py-2 text-right font-medium">DPR</th>
                <th className="px-3 py-2 text-right font-medium">CCWM</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.teamKey} className="border-t border-white/5 hover:bg-white/[0.04]">
                  <td className="px-3 py-2 text-right text-neutral-500">{index + 1}</td>
                  <td className="max-w-0 px-3 py-2">
                    <div className="truncate font-semibold text-neutral-200">{formatTeamNumber(row.teamKey)}</div>
                    <div className="truncate text-[10px] text-neutral-500">{row.name}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-white">{row.opr?.toFixed(2) ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-neutral-400">{row.dpr?.toFixed(2) ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-neutral-400">{row.ccwm?.toFixed(2) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex h-full min-h-36 items-center justify-center p-6 text-center">
            <div>
              <div className="text-sm font-medium text-neutral-300">
                {loading ? "Loading event data…" : "OPR data is not available yet"}
              </div>
              <p className="mt-2 max-w-xs text-xs leading-5 text-neutral-500">
                Team performance statistics appear when The Blue Alliance publishes event OPRs.
              </p>
            </div>
          </div>
        )}
      </div>
      <footer className="shrink-0 border-t border-white/10 px-3 py-2 text-[10px] text-neutral-600">
        OPR · DPR · CCWM · Source: The Blue Alliance
      </footer>
    </section>
  );
}

/** Standalone data-connected wrapper for any client page or component. */
export default function EventDataPanel(props: EventDataPanelProps) {
  const snapshot = useEventState(props.eventKey);
  return <EventDataPanelContent {...props} snapshot={snapshot} />;
}
