import type { TBAEvent } from "@/lib/tba/types";
import type {
  MatchImminentSignal,
  MultiviewState,
} from "./MultiviewState";

export type MultiviewActions = {
  showControls(): void;
  hideControls(): void;
  toggleSidebar(): void;
  setSidebarOpen(open: boolean): void;

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
};

export type MultiviewActionSource =
  | MultiviewActions
  | ((actions: MultiviewActions) => void);

export type MultiviewController = {
  getState(): MultiviewState;
  subscribe(listener: (state: MultiviewState) => void): () => void;
  actions: MultiviewActions;
};
