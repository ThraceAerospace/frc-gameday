"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { PlusIcon } from "@heroicons/react/24/outline";
import EventView from "@/components/eventview/EventView";
import ImminentMatchBanner from "@/components/eventview/ImminentMatchBanner";
import { useEventState } from "@/lib/events";
import { LAYOUTS, pickLayout } from "@/lib/multiview/layouts";
import type { TileSurfaceController } from "./TileSurfaceActions";
import type { TileSurfaceState } from "./TileSurfaceState";
import type { EventViewPresentation } from "@/components/eventview/EventViewConfig";

type SurfaceUpcomingMatchAlert = {
  eventKey: string;
  match: TBAMatch;
  teams: string[];
  eventName: string;
  eventTimezone: string | null;
};

function SurfaceUpcomingMatchAlertSource({
  eventKey,
  config,
  onAlert,
}: {
  eventKey: string;
  config: TileSurfaceState["eventConfigs"][string] | undefined;
  onAlert: (eventKey: string, alert: SurfaceUpcomingMatchAlert | null) => void;
}) {
  const { event, matches, upcomingMatchKey } = useEventState(eventKey);
  const upcomingMatch = matches.find((match) => match.key === upcomingMatchKey) ?? null;
  const upcomingTeams = useMemo(() => {
    if (!config?.matchNotifications || !upcomingMatch) return [];

    const matchTeams = [
      ...(upcomingMatch.alliances.red.team_keys ?? []),
      ...(upcomingMatch.alliances.blue.team_keys ?? []),
    ];

    return config.trackedTeams.filter((team) => matchTeams.includes(team));
  }, [config?.matchNotifications, config?.trackedTeams, upcomingMatch]);

  useEffect(() => {
    if (!config?.matchNotifications) {
      onAlert(eventKey, null);
      return;
    }

    // A webhook may arrive before the refreshed match list is available.
    // Keep the current banner until we can resolve the updated match.
    if (!upcomingMatch) return;

    if (upcomingTeams.length === 0) {
      onAlert(eventKey, null);
      return;
    }

    onAlert(eventKey, {
      eventKey,
      match: upcomingMatch,
      teams: upcomingTeams,
      eventName: event?.short_name || event?.name || eventKey,
      eventTimezone: event?.timezone ?? null,
    });
  }, [
    config?.matchNotifications,
    event?.name,
    event?.short_name,
    event?.timezone,
    eventKey,
    onAlert,
    upcomingMatch,
    upcomingMatchKey,
    upcomingTeams,
  ]);

  return null;
}

type TileViewProps = {
  controller: TileSurfaceController;
  isDivisional?: boolean;
  className?: string;
  renderEventView?: (args: {
    eventKey: string;
    controller: TileSurfaceController;
    config: TileSurfaceState["eventConfigs"][string] | undefined;
    slotPresentation: EventViewPresentation;
  }) => ReactNode;
};

function getSlotPresentation(
  geometry: (typeof LAYOUTS)[keyof typeof LAYOUTS]["slots"][number] | undefined,
): EventViewPresentation {
  return (
    geometry?.presentation ?? {
      teamTracker: "hidden",
      matchInfo: "visible",
    }
  );
}

export default function TileView({
  controller,
  isDivisional = false,
  className = "",
  renderEventView,
}: TileViewProps) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  const [controlHeld, setControlHeld] = useState(false);
  const [upcomingAlert, setUpcomingAlert] = useState<SurfaceUpcomingMatchAlert | null>(null);

  const handleUpcomingAlert = useCallback((
    eventKey: string,
    alert: SurfaceUpcomingMatchAlert | null,
  ) => {
    setUpcomingAlert((current) => {
      if (!alert) {
        return current?.eventKey === eventKey ? null : current;
      }

      // Always accept fresh webhook-derived data, even for the same match key.
      return alert;
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control") {
        setControlHeld(true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control") {
        setControlHeld(false);
      }
    };

    const handleBlur = () => setControlHeld(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  const autoLayoutKey = pickLayout(state.streams.length || 1);
  const selectedLayoutKey =
    state.highlightLayoutKey ?? state.layoutKey ?? autoLayoutKey;
  const layout = LAYOUTS[selectedLayoutKey] ?? LAYOUTS.single;

  const slotOrder =
    state.activeKey && state.priority.includes(state.activeKey)
      ? [
          state.activeKey,
          ...state.priority.filter(
            (eventKey) => eventKey !== state.activeKey,
          ),
        ]
      : state.priority;

  const emptySlotCount = Math.max(
    0,
    layout.slots.length - state.streams.length,
  );

  return (
    <main className={`relative min-h-0 flex-1 ${className}`}>
      {state.streams.map((tileId) => {
        const eventKey = state.tileEvents[tileId] ?? tileId;
        return (
          <SurfaceUpcomingMatchAlertSource
            key={"alert-source-" + tileId}
            eventKey={eventKey}
            config={state.eventConfigs[eventKey]}
            onAlert={handleUpcomingAlert}
          />
        );
      })}

      {upcomingAlert && state.streams.some((tileId) => state.tileEvents[tileId] === upcomingAlert.eventKey) && (
        <ImminentMatchBanner
          key={upcomingAlert.eventKey + ":" + upcomingAlert.match.key}
          match={upcomingAlert.match}
          teams={upcomingAlert.teams}
          eventName={upcomingAlert.eventName}
          eventTimezone={upcomingAlert.eventTimezone}
        />
      )}

      {state.streams.map((tileId) => {
        const eventKey = state.tileEvents[tileId] ?? tileId;
        const slotIndex = slotOrder.indexOf(tileId);
        const geometry = layout.slots[slotIndex];
        const slotPresentation = getSlotPresentation(geometry);
        const visible = Boolean(geometry);

        return (
          <div
            key={tileId}
            className={[
              visible ? "absolute rounded-[inherit]" : "pointer-events-none absolute invisible",
              state.priorityEditKey === tileId
                ? "border border-blue-500/90 shadow-[0_0_0_1px_rgba(59,130,246,0.35),0_0_24px_rgba(59,130,246,0.12)]"
                : "border border-transparent",
            ].join(" ")}
            style={
              visible
                ? {
                    left: `${geometry!.x}%`,
                    top: `${geometry!.y}%`,
                    width: `${geometry!.w}%`,
                    height: `${geometry!.h}%`,
                    transition: "all 300ms ease",
                  }
                : {
                    left: 0,
                    top: 0,
                    width: 1,
                    height: 1,
                  }
            }
          >
            <div
              className={[
                "pointer-events-none absolute inset-0 z-30 rounded-[inherit] border-2 border-amber-400/90",
                "transition-[opacity,box-shadow] duration-500 ease-out",
                Boolean(state.upcomingMatchKeys?.[eventKey])
                  ? "opacity-100 shadow-[0_0_0_1px_rgba(251,191,36,0.3),0_0_28px_rgba(251,191,36,0.16)]"
                  : "opacity-0 shadow-none",
              ].join(" ")}
              aria-hidden="true"
            />

            {renderEventView ? (
              renderEventView({
                eventKey,
                controller,
                config: state.eventConfigs[eventKey],
                slotPresentation,
              })
            ) : (
              <EventView
                event={eventKey}
                priorityEditing={state.priorityEditKey === tileId}
                upcomingMatchKey={state.upcomingMatchKeys?.[eventKey] ?? null}
                isDivisional={isDivisional}
                controller={controller}
                onToggleActive={() => controller.actions.toggleActive(tileId)}
                slotNumber={state.streams.indexOf(tileId) + 1}
                controlHeld={controlHeld}
                config={state.eventConfigs[eventKey]}
                slotPresentation={slotPresentation}
              />
            )}
          </div>
        );
      })}

      {Array.from({ length: emptySlotCount }).map((_, index) => {
        const slotIndex = state.streams.length + index;
        const geometry = layout.slots[slotIndex];

        if (!geometry) return null;

        return (
          <button
            key={`empty-slot-${slotIndex}`}
            type="button"
            onClick={controller.actions.openEventPicker}
            className="absolute flex items-center justify-center border border-dashed border-neutral-700 bg-neutral-950/80 transition-colors hover:border-neutral-500 hover:bg-neutral-900"
            style={{
              left: `${geometry.x}%`,
              top: `${geometry.y}%`,
              width: `${geometry.w}%`,
              height: `${geometry.h}%`,
            }}
          >
            <div className="flex flex-col items-center gap-2 text-neutral-500">
              <PlusIcon className="h-8 w-8" />
              <span className="text-sm font-semibold">Add Event</span>
            </div>
          </button>
        );
      })}
    </main>
  );
}
