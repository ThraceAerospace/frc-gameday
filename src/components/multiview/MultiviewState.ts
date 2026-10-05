"use client";

import type { TBAEvent } from "@/lib/tba/types";
import type { LAYOUTS } from "@/lib/multiview/layouts";

type LayoutKey = keyof typeof LAYOUTS;

export type MultiviewState = {
  streams: string[];
  priority: string[];
  layoutKey: LayoutKey | null;
  activeKey: string | null;
  highlightLayoutKey: LayoutKey | null;
  sidebarOpen: boolean;
  autoFocusMatches: boolean;
  eventPickerOpen: boolean;
  eventSearch: string;
  availableEvents: TBAEvent[];
  eventsLoading: boolean;
  labels: Record<string, string>;
  controlsVisible: boolean;
  priorityEditKey: string | null;
};

export type MatchImminentSignal = {
  type: "match_imminent";
  matchKey: string;
  severity: "hard" | "soft";
};

export function createInitialMultiviewState(
  events: string[]
): MultiviewState {
  const streams = [...new Set(events.filter(Boolean).map(String))];

  return {
    streams,
    priority: streams,
    layoutKey: null,
    activeKey: null,
    highlightLayoutKey: null,
    sidebarOpen: false,
    autoFocusMatches: true,
    eventPickerOpen: false,
    eventSearch: "",
    availableEvents: [],
    eventsLoading: false,
    labels: {},
    controlsVisible: true,
    priorityEditKey: null,
  };
}
