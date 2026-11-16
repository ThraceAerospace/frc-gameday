import type { TBAEvent } from "@/lib/tba/types";
import type {
  UpcomingMatchAlert,
  TileSurfaceState,
} from "./TileSurfaceState";
import type {
  EventViewCommandType,
  EventViewConfig,
  EventViewPresentation,
} from "@/components/eventview/EventViewConfig";

export type TileSurfaceActions = {
  showControls(): void;
  hideControls(): void;

  setUpcomingMatchAlert(signal: UpcomingMatchAlert): void;
  highlightEvent(eventKey: string): void;
  highlightMatch(eventKey: string, matchKey: string): void;
  releaseMatchHighlight(eventKey: string, matchKey: string): void;

  toggleActive(eventKey: string): void;
  clearActive(): void;

  setLayout(layoutKey: TileSurfaceState["layoutKey"]): void;
  resetLayout(): void;

  movePriority(position: number, direction: -1 | 1): void;
  selectPriorityEdit(eventKey: string | null): void;
  movePriorityEdit(direction: -1 | 1): void;

  openEventPicker(): void;
  closeEventPicker(): void;
  setEventSearch(search: string): void;
  addEvent(event: TBAEvent): void;
  removeEvent(tileId: string): void;

  registerLabel(eventKey: string, label: string): void;

  setEventViewConfig(eventKey: string, config: Partial<EventViewConfig>): void;
  setEventViewTrackedTeams(eventKey: string, teams: string[]): void;
  setEventViewStream(eventKey: string, streamKey: string | null): void;
  setEventViewPresentation(eventKey: string, presentation: Partial<EventViewPresentation>): void;
  runEventViewCommand(eventKey: string, type: EventViewCommandType): void;
  clearEventViewCommand(eventKey: string): void;
};

export type TileSurfaceActionSource =
  | TileSurfaceActions
  | ((actions: TileSurfaceActions) => void);

export type TileSurfaceController = {
  getState(): TileSurfaceState;
  replaceState(state: TileSurfaceState): void;
  subscribe(listener: (state: TileSurfaceState) => void): () => void;
  actions: TileSurfaceActions;
};
