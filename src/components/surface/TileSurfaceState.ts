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
  autoFocusMatches: boolean;
  imminentMatchKey: string | null;
  preImminenceState: {
    activeKey: string | null;
    highlightLayoutKey: LayoutKey | null;
  } | null;
  eventPickerOpen: boolean;
  eventSearch: string;
  availableEvents: TBAEvent[];
  eventsLoading: boolean;
  labels: Record<string, string>;
  controlsVisible: boolean;
  priorityEditKey: string | null;
};

export type MatchImminentSignal =
  | {
      type: "match_imminent";
      matchKey: string;
      severity: "hard" | "soft";
    }
  | {
      type: "match_no_longer_imminent";
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
    autoFocusMatches: false,
  imminentMatchKey: null,
  preImminenceState: null,
    eventPickerOpen: false,
    eventSearch: "",
    availableEvents: [],
    eventsLoading: false,
    labels: {},
    controlsVisible: true,
    priorityEditKey: null,
  };
}
