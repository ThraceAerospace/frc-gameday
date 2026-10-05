export type EventViewVisibility = "visible" | "hidden";

export type EventViewFooterMode = "matchStrip" | "rankings" | "split" | "hidden";

export type EventViewPresentation = {
  teamTracker: EventViewVisibility;
  matchInfo: EventViewVisibility;
};

export type EventViewCommandType = "teams" | "stream" | "refresh";

export type EventViewCommand = {
  id: number;
  type: EventViewCommandType;
};

export type EventViewConfig = {
  trackedTeams: string[];
  selectedStream: string | null;
  presentation: EventViewPresentation;
  footerMode: EventViewFooterMode;
  command: EventViewCommand | null;
};

export const DEFAULT_EVENT_VIEW_CONFIG: EventViewConfig = {
  trackedTeams: [],
  selectedStream: null,
  presentation: {
    teamTracker: "visible",
    matchInfo: "visible",
  },
  command: null,
  footerMode: "matchStrip",
};

export function createEventViewConfig(
  overrides: Partial<EventViewConfig> = {},
): EventViewConfig {
  return {
    ...DEFAULT_EVENT_VIEW_CONFIG,
    ...overrides,
    trackedTeams: [...(overrides.trackedTeams ?? DEFAULT_EVENT_VIEW_CONFIG.trackedTeams)],
    presentation: {
      ...DEFAULT_EVENT_VIEW_CONFIG.presentation,
      ...overrides.presentation,
    },
  };
}
