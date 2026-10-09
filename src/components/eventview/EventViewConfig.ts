export type EventViewVisibility = "visible" | "hidden";

export type EventViewFooterMode = "matchStrip" | "rankings" | "split" | "statbotics" | "hidden";

export type EventViewPresentation = {
  teamTracker: EventViewVisibility;
  matchInfo: EventViewVisibility;
};

export type EventViewCommandType = "teams" | "stream" | "refresh" | "reloadStream";

export type EventViewCommand = {
  id: number;
  type: EventViewCommandType;
};

export type EventViewConfig = {
  trackedTeams: string[];
  autoHighlight: boolean;
  matchNotifications: boolean;
  selectedStream: string | null;
  presentation: EventViewPresentation;
  footerMode: EventViewFooterMode;
  streamMuted: boolean;
  streamVolume: number;
  command: EventViewCommand | null;
};

export const DEFAULT_EVENT_VIEW_CONFIG: EventViewConfig = {
  trackedTeams: [],
  autoHighlight: false,
  matchNotifications: true,
  selectedStream: null,
  presentation: {
    teamTracker: "visible",
    matchInfo: "visible",
  },
  command: null,
  footerMode: "matchStrip",
  streamMuted: true,
  streamVolume: 100,
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
