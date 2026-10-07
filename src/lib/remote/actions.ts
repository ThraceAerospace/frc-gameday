import type { TBAEvent } from "@/lib/tba/types";
import type { MatchImminentSignal, TileSurfaceState } from "@/components/surface/TileSurfaceState";
import type { EventViewCommandType, EventViewConfig, EventViewPresentation } from "@/components/eventview/EventViewConfig";
import type { TileSurfaceActions, TileSurfaceController } from "@/components/surface/TileSurfaceActions";

export type RemoteMultiviewMessage =
  | { type: "action"; action: RemoteMultiviewAction }
  | { type: "requestState" }
  | { type: "stateSnapshot"; state: TileSurfaceState };

export type RemoteMultiviewAction =
  | { type: "showControls" }
  | { type: "hideControls" }
  | { type: "setAutoFocusMatches"; enabled: boolean }
  | { type: "handleMatchImminent"; signal: string | MatchImminentSignal }
  | { type: "toggleActive"; eventKey: string }
  | { type: "clearActive" }
  | { type: "setLayout"; layoutKey: TileSurfaceState["layoutKey"] }
  | { type: "resetLayout" }
  | { type: "movePriority"; position: number; direction: -1 | 1 }
  | { type: "selectPriorityEdit"; eventKey: string | null }
  | { type: "movePriorityEdit"; direction: -1 | 1 }
  | { type: "openEventPicker" }
  | { type: "closeEventPicker" }
  | { type: "setEventSearch"; search: string }
  | { type: "addEvent"; event: TBAEvent }
  | { type: "removeEvent"; eventKey: string }
  | { type: "registerLabel"; eventKey: string; label: string }
  | { type: "setEventViewConfig"; eventKey: string; config: Partial<EventViewConfig> }
  | { type: "setEventViewTrackedTeams"; eventKey: string; teams: string[] }
  | { type: "setEventViewStream"; eventKey: string; streamKey: string | null }
  | { type: "setEventViewPresentation"; eventKey: string; presentation: Partial<EventViewPresentation> }
  | { type: "runEventViewCommand"; eventKey: string; commandType: EventViewCommandType }
  | { type: "clearEventViewCommand"; eventKey: string };

export function createRemoteMultiviewActions(
  localController: TileSurfaceController,
  send: (action: RemoteMultiviewAction) => void,
): TileSurfaceActions {
  const local = localController.actions;

  return {
    showControls() { local.showControls(); send({ type: "showControls" }); },
    hideControls() { local.hideControls(); send({ type: "hideControls" }); },
    setAutoFocusMatches(enabled) { local.setAutoFocusMatches(enabled); send({ type: "setAutoFocusMatches", enabled }); },
    handleMatchImminent(signal) { local.handleMatchImminent(signal); send({ type: "handleMatchImminent", signal }); },
    toggleActive(eventKey) { local.toggleActive(eventKey); send({ type: "toggleActive", eventKey }); },
    clearActive() { local.clearActive(); send({ type: "clearActive" }); },
    setLayout(layoutKey) { local.setLayout(layoutKey); send({ type: "setLayout", layoutKey }); },
    resetLayout() { local.resetLayout(); send({ type: "resetLayout" }); },
    movePriority(position, direction) { local.movePriority(position, direction); send({ type: "movePriority", position, direction }); },
    selectPriorityEdit(eventKey) { local.selectPriorityEdit(eventKey); send({ type: "selectPriorityEdit", eventKey }); },
    movePriorityEdit(direction) { local.movePriorityEdit(direction); send({ type: "movePriorityEdit", direction }); },
    openEventPicker() { local.openEventPicker(); send({ type: "openEventPicker" }); },
    closeEventPicker() { local.closeEventPicker(); send({ type: "closeEventPicker" }); },
    setEventSearch(search) { local.setEventSearch(search); send({ type: "setEventSearch", search }); },
    addEvent(event) { local.addEvent(event); send({ type: "addEvent", event }); },
    removeEvent(eventKey) { local.removeEvent(eventKey); send({ type: "removeEvent", eventKey }); },
    registerLabel(eventKey, label) { local.registerLabel(eventKey, label); send({ type: "registerLabel", eventKey, label }); },
    setEventViewConfig(eventKey, config) { local.setEventViewConfig(eventKey, config); send({ type: "setEventViewConfig", eventKey, config }); },
    setEventViewTrackedTeams(eventKey, teams) { local.setEventViewTrackedTeams(eventKey, teams); send({ type: "setEventViewTrackedTeams", eventKey, teams }); },
    setEventViewStream(eventKey, streamKey) { local.setEventViewStream(eventKey, streamKey); send({ type: "setEventViewStream", eventKey, streamKey }); },
    setEventViewPresentation(eventKey, presentation) { local.setEventViewPresentation(eventKey, presentation); send({ type: "setEventViewPresentation", eventKey, presentation }); },
    runEventViewCommand(eventKey, commandType) { local.runEventViewCommand(eventKey, commandType); send({ type: "runEventViewCommand", eventKey, commandType }); },
    clearEventViewCommand(eventKey) { local.clearEventViewCommand(eventKey); send({ type: "clearEventViewCommand", eventKey }); },
  };
}

export function applyRemoteMultiviewAction(
  controller: TileSurfaceController,
  action: RemoteMultiviewAction,
) {
  const actions = controller.actions;

  switch (action.type) {
    case "showControls": actions.showControls(); break;
    case "hideControls": actions.hideControls(); break;
    case "setAutoFocusMatches": actions.setAutoFocusMatches(action.enabled); break;
    case "handleMatchImminent": actions.handleMatchImminent(action.signal); break;
    case "toggleActive": actions.toggleActive(action.eventKey); break;
    case "clearActive": actions.clearActive(); break;
    case "setLayout": actions.setLayout(action.layoutKey); break;
    case "resetLayout": actions.resetLayout(); break;
    case "movePriority": actions.movePriority(action.position, action.direction); break;
    case "selectPriorityEdit": actions.selectPriorityEdit(action.eventKey); break;
    case "movePriorityEdit": actions.movePriorityEdit(action.direction); break;
    case "openEventPicker": actions.openEventPicker(); break;
    case "closeEventPicker": actions.closeEventPicker(); break;
    case "setEventSearch": actions.setEventSearch(action.search); break;
    case "addEvent": actions.addEvent(action.event); break;
    case "removeEvent": actions.removeEvent(action.eventKey); break;
    case "registerLabel": actions.registerLabel(action.eventKey, action.label); break;
    case "setEventViewConfig": actions.setEventViewConfig(action.eventKey, action.config); break;
    case "setEventViewTrackedTeams": actions.setEventViewTrackedTeams(action.eventKey, action.teams); break;
    case "setEventViewStream": actions.setEventViewStream(action.eventKey, action.streamKey); break;
    case "setEventViewPresentation": actions.setEventViewPresentation(action.eventKey, action.presentation); break;
    case "runEventViewCommand": actions.runEventViewCommand(action.eventKey, action.commandType); break;
    case "clearEventViewCommand": actions.clearEventViewCommand(action.eventKey); break;
  }
}
