export type EventViewVisibility = "visible" | "hidden";

export type EventViewPresentation = {
  teamTracker: EventViewVisibility;
  matchInfo: EventViewVisibility;
};

export type EventViewConfig = {
  trackedTeams: string[];
  selectedStream: string | null;
  chatOpen: boolean;
  presentation: EventViewPresentation;
};

export const DEFAULT_EVENT_VIEW_CONFIG: EventViewConfig = {
  trackedTeams: [],
  selectedStream: null,
  chatOpen: false,
  presentation: {
    teamTracker: "visible",
    matchInfo: "visible",
  },
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
