import type { TBAEvent } from "@/lib/tba/types";
import type {
  MatchImminentSignal,
  MultiviewState,
} from "./MultiviewState";
import type {
  EventViewCommandType,
  EventViewConfig,
  EventViewPresentation,
} from "@/components/eventview/EventViewConfig";

export type MultiviewActions = {
  showControls(): void;
  hideControls(): void;

  setAutoFocusMatches(enabled: boolean): void;
  handleMatchImminent(signal: string | MatchImminentSignal): void;

  toggleActive(eventKey: string): void;
  clearActive(): void;

  setLayout(layoutKey: MultiviewState["layoutKey"]): void;
  resetLayout(): void;

  movePriority(position: number, direction: -1 | 1): void;
  selectPriorityEdit(eventKey: string | null): void;
  movePriorityEdit(direction: -1 | 1): void;

  openEventPicker(): void;
  closeEventPicker(): void;
  setEventSearch(search: string): void;
  addEvent(event: TBAEvent): void;
  removeEvent(eventKey: string): void;

  registerLabel(eventKey: string, label: string): void;

  setEventViewConfig(eventKey: string, config: Partial<EventViewConfig>): void;
  setEventViewTrackedTeams(eventKey: string, teams: string[]): void;
  setEventViewStream(eventKey: string, streamKey: string | null): void;
  setEventViewPresentation(eventKey: string, presentation: Partial<EventViewPresentation>): void;
  runEventViewCommand(eventKey: string, type: EventViewCommandType): void;
  clearEventViewCommand(eventKey: string): void;
};

export type MultiviewActionSource =
  | MultiviewActions
  | ((actions: MultiviewActions) => void);

export type MultiviewController = {
  getState(): MultiviewState;
  replaceState(state: MultiviewState): void;
  subscribe(listener: (state: MultiviewState) => void): () => void;
  actions: MultiviewActions;
};
