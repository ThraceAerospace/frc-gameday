"use client";

import type { FieldViewEvent } from "@fieldview/domain";
import type { LAYOUTS } from "@/lib/multiview/layouts";
import { createEventViewConfig, EventViewConfig } from "@/components/eventview/EventViewConfig";


type LayoutKey = keyof typeof LAYOUTS;

export type TileSurfaceState = {
  eventConfigs: Record<string, EventViewConfig>;
  /** Stable tile identity -> event key. Multiple tile types may reference one event. */
  tileEvents: Record<string, string>;
  tileTypes: Record<string, "eventView">;
  streams: string[];
  priority: string[];
  layoutKey: LayoutKey | null;
  activeKey: string | null;
  highlightLayoutKey: LayoutKey | null;
  upcomingMatchKeys: Record<string, string>;
  /** Events currently holding an imminent-match auto-highlight. */
  imminentMatchKeys: Record<string, string>;
  eventPickerOpen: boolean;
  eventSearch: string;
  availableEvents: FieldViewEvent[];
  eventsLoading: boolean;
  eventsError: string | null;
  labels: Record<string, string>;
  controlsVisible: boolean;
  priorityEditKey: string | null;
};

export type UpcomingMatchAlert =
  | {
      type: "upcoming_match";
      eventKey: string;
      matchKey: string;
    }
  | {
      type: "upcoming_match_cleared";
      eventKey: string;
      matchKey: string;
    };

export function createInitialTileSurfaceState(
  events: string[],
): TileSurfaceState {
  const eventKeys = [...new Set(events.filter(Boolean).map(String))];
  const streams = eventKeys;
  const eventConfigs = Object.fromEntries(
    eventKeys.map((eventKey) => [eventKey, createEventViewConfig()])
  );
  const tileEvents = Object.fromEntries(
    eventKeys.map((eventKey) => [eventKey, eventKey] as const),
  );
  const tileTypes = Object.fromEntries(
    eventKeys.map((eventKey) => [eventKey, "eventView" as const]),
  );

  return {
    eventConfigs,
    tileEvents,
    tileTypes,
    streams,
    priority: streams,
    layoutKey: null,
    activeKey: null,
    highlightLayoutKey: null,
    upcomingMatchKeys: {},
    imminentMatchKeys: {},
    eventPickerOpen: false,
    eventSearch: "",
    availableEvents: [],
    eventsLoading: false,
    eventsError: null,
    labels: {},
    controlsVisible: true,
    priorityEditKey: null,
  };
}
