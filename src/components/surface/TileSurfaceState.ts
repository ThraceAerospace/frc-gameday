"use client";

import type { TBAEvent } from "@/lib/tba/types";
import type { LAYOUTS } from "@/lib/multiview/layouts";
import { createEventViewConfig, EventViewConfig } from "@/components/eventview/EventViewConfig";


type LayoutKey = keyof typeof LAYOUTS;

export type TileSurfaceState = {
  eventConfigs: Record<string, EventViewConfig>;
  streams: string[];
  priority: string[];
  layoutKey: LayoutKey | null;
  activeKey: string | null;
  highlightLayoutKey: LayoutKey | null;
  upcomingMatchKey: string | null;
  eventPickerOpen: boolean;
  eventSearch: string;
  availableEvents: TBAEvent[];
  eventsLoading: boolean;
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
  events: string[]
): TileSurfaceState {
  const streams = [...new Set(events.filter(Boolean).map(String))];
  const eventConfigs = Object.fromEntries(
    streams.map((eventKey) => [eventKey, createEventViewConfig()])
  );

  return {
    eventConfigs,
    streams,
    priority: streams,
    layoutKey: null,
    activeKey: null,
    highlightLayoutKey: null,
    upcomingMatchKey: null,
    eventPickerOpen: false,
    eventSearch: "",
    availableEvents: [],
    eventsLoading: false,
    labels: {},
    controlsVisible: true,
    priorityEditKey: null,
  };
}
