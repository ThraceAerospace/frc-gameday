"use client";

import {
  getLastMatch,
  getNextMatch,
  sortMatches,
} from "@/lib/gameday/matchUtils";
import type {
  TBAEliminationAlliance,
  TBAEvent,
  TBAEventTeamStatuses,
  TBAMatch,
  TBATeam,
} from "@/lib/tba/types";
import {
  eventWebSocket,
  type EventWebSocketMessage,
  type EventWebSocketStatus,
} from "@/lib/realtime/client";

export type EventStateSnapshot = {
  event: TBAEvent | null;
  teams: TBATeam[];
  matches: TBAMatch[];
  eventNextMatch: TBAMatch | null;
  eventLastMatch: TBAMatch | null;
  teamsStatuses: TBAEventTeamStatuses;
  alliances: TBAEliminationAlliance[];
  loading: boolean;
  error: Error | null;
  websocketStatus: EventWebSocketStatus;
  websocketStale: boolean;
};

type Listener = (snapshot: EventStateSnapshot) => void;

const MATCH_POLL_INTERVAL = 5 * 60_000;
const STATUS_POLL_INTERVAL = 5 * 60_000;
const ALLIANCE_POLL_INTERVAL = 15 * 60_000;
const AUTHORITATIVE_REFETCH_DELAY = 65_000;

export class EventState {
  readonly eventKey: string;

  private snapshot: EventStateSnapshot = {
    event: null,
    teams: [],
    matches: [],
    eventNextMatch: null,
    eventLastMatch: null,
    teamsStatuses: {},
    alliances: [],
    loading: true,
    error: null,
    websocketStatus: "disconnected",
    websocketStale: false,
  };

  private readonly listeners = new Set<Listener>();

  private started = false;
  private startScheduled = false;
  private stopped = false;
  private unsubscribeWebSocket: (() => void) | null = null;
  private unsubscribeWebSocketStatus: (() => void) | null = null;

  private matchTimer: number | null = null;
  private statusTimer: number | null = null;
  private allianceTimer: number | null = null;

  private eventRequest = 0;
  private teamsRequest = 0;
  private matchesRequest = 0;
  private statusesRequest = 0;
  private alliancesRequest = 0;

  private readonly authoritativeTimers = new Map<string, number>();

  constructor(eventKey: string) {
    this.eventKey = eventKey;
  }

  getSnapshot(): EventStateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    if (!this.started && !this.startScheduled) {
      this.startScheduled = true;

      queueMicrotask(() => {
        this.startScheduled = false;

        if (this.listeners.size > 0 && !this.started) {
          this.start();
        }
      });
    }

    return () => {
      this.listeners.delete(listener);

      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  start() {
    if (this.started || !this.eventKey) {
      return;
    }

    this.stopped = false;
    this.started = true;

    this.unsubscribeWebSocket =
      eventWebSocket.subscribe(
        this.eventKey,
        this.handleWebSocketMessage,
      );

    this.unsubscribeWebSocketStatus =
      eventWebSocket.subscribeStatus(
        this.handleWebSocketStatus,
      );

    void this.loadEvent();
    void this.loadTeams();
    void this.loadMatches();
    void this.loadStatuses();
    void this.loadAlliances();

    this.scheduleMatchFallback();
    this.scheduleStatusFallback();
    this.scheduleAllianceFallback();
  }

  stop() {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.started = false;

    this.unsubscribeWebSocket?.();
    this.unsubscribeWebSocketStatus?.();

    this.clearTimer("match");
    this.clearTimer("status");
    this.clearTimer("alliance");

    for (const timer of this.authoritativeTimers.values()) {
      window.clearTimeout(timer);
    }

    this.authoritativeTimers.clear();
  }

  reloadAll() {
    void this.loadEvent();
    void this.loadTeams();
    void this.loadMatches();
    void this.loadStatuses();
    void this.loadAlliances();
  }

  reloadMatches() {
    void this.loadMatches();
  }

  reloadStatuses() {
    void this.loadStatuses();
  }

  reloadAlliances() {
    void this.loadAlliances();
  }

  private update(
    updater: (
      current: EventStateSnapshot,
    ) => EventStateSnapshot,
  ) {
    this.snapshot = updater(this.snapshot);

    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private async loadEvent() {
    const request = ++this.eventRequest;

    this.update((current) => ({
      ...current,
      loading: true,
      error: null,
    }));

    try {
      const response = await fetch(
        `/api/event/${encodeURIComponent(this.eventKey)}`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(
          `Event request failed: ${response.status}`,
        );
      }

      const event = (await response.json()) as TBAEvent;

      if (request !== this.eventRequest || this.stopped) {
        return;
      }

      this.update((current) => ({
        ...current,
        event,
        loading: false,
        error: null,
      }));
    } catch (error) {
      if (request !== this.eventRequest || this.stopped) {
        return;
      }

      this.update((current) => ({
        ...current,
        event: null,
        loading: false,
        error:
          error instanceof Error
            ? error
            : new Error("Event request failed"),
      }));
    }
  }

  private async loadTeams() {
    const request = ++this.teamsRequest;

    if (!this.eventKey) {
      return;
    }

    try {
      const response = await fetch(
        `/api/event/${encodeURIComponent(this.eventKey)}/teams`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(
          `Teams request failed: ${response.status}`,
        );
      }

      const data = await response.json();

      if (request !== this.teamsRequest || this.stopped) {
        return;
      }

      this.update((current) => ({
        ...current,
        teams: Array.isArray(data) ? (data as TBATeam[]) : [],
      }));
    } catch (error) {
      if (request !== this.teamsRequest || this.stopped) {
        return;
      }

      console.error("[EventState] teams request failed", error);
    }
  }

  private async loadMatches() {
    const request = ++this.matchesRequest;

    try {
      const response = await fetch(
        `/api/event/${encodeURIComponent(this.eventKey)}/matches`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const matches = Array.isArray(data)
        ? sortMatches(data as TBAMatch[])
        : [];

      if (request !== this.matchesRequest || this.stopped) {
        return;
      }

      this.update((current) => ({
        ...current,
        matches,
        eventNextMatch: getNextMatch(matches),
        eventLastMatch: getLastMatch(matches),
      }));

      this.scheduleMatchFallback();
    } catch (error) {
      if (request !== this.matchesRequest || this.stopped) {
        return;
      }

      console.error("[EventState] matches request failed", error);
      this.scheduleMatchFallback();
    }
  }

  private async loadStatuses() {
    const request = ++this.statusesRequest;

    try {
      const response = await fetch(
        `/api/event/${encodeURIComponent(this.eventKey)}/teams/statuses`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data =
        (await response.json()) as TBAEventTeamStatuses;

      if (request !== this.statusesRequest || this.stopped) {
        return;
      }

      this.update((current) => ({
        ...current,
        teamsStatuses: data ?? {},
      }));

      this.scheduleStatusFallback();
    } catch (error) {
      if (request !== this.statusesRequest || this.stopped) {
        return;
      }

      console.error("[EventState] statuses request failed", error);
      this.scheduleStatusFallback();
    }
  }

  private async loadAlliances() {
    const request = ++this.alliancesRequest;

    try {
      const response = await fetch(
        `/api/event/${encodeURIComponent(this.eventKey)}/playoffs/alliances`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (request !== this.alliancesRequest || this.stopped) {
        return;
      }

      this.update((current) => ({
        ...current,
        alliances: Array.isArray(data)
          ? (data as TBAEliminationAlliance[])
          : [],
      }));

      this.scheduleAllianceFallback();
    } catch (error) {
      if (request !== this.alliancesRequest || this.stopped) {
        return;
      }

      console.error("[EventState] alliances request failed", error);
      this.scheduleAllianceFallback();
    }
  }

  private handleWebSocketStatus = (
    status: EventWebSocketStatus,
  ) => {
    if (this.stopped) {
      return;
    }

    this.update((current) => ({
      ...current,
      websocketStatus: status,
    }));
  };

  private handleWebSocketMessage = (
    message: EventWebSocketMessage,
  ) => {
    if (
      this.stopped ||
      message.type !== "tba-update" ||
      (message.eventKey && message.eventKey !== this.eventKey)
    ) {
      return;
    }

    this.update((current) => ({
      ...current,
      websocketStale: true,
    }));

    switch (message.messageType) {
      case "upcoming_match":
      case "match_score":
      case "match_video":
        this.reloadMatches();
        this.reloadStatuses();
        break;

      case "starting_comp_level":
      case "schedule_updated":
        this.reloadAll();
        break;

      case "alliance_selection":
        this.reloadAlliances();
        this.reloadStatuses();
        this.reloadMatches();
        break;

      default:
        this.reloadAll();
        break;
    }

    const refreshKey =
      message.messageType ?? message.type;

    const existing =
      this.authoritativeTimers.get(refreshKey);

    if (existing !== undefined) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(() => {
      this.authoritativeTimers.delete(refreshKey);
      this.update((current) => ({
        ...current,
        websocketStale: false,
      }));

      switch (message.messageType) {
        case "upcoming_match":
        case "match_score":
        case "match_video":
          this.reloadMatches();
          this.reloadStatuses();
          break;

        case "starting_comp_level":
        case "schedule_updated":
          this.reloadAll();
          break;

        case "alliance_selection":
          this.reloadAlliances();
          this.reloadStatuses();
          this.reloadMatches();
          break;

        default:
          this.reloadAll();
          break;
      }
    }, AUTHORITATIVE_REFETCH_DELAY);

    this.authoritativeTimers.set(refreshKey, timer);
  };

  private scheduleMatchFallback() {
    this.clearTimer("match");

    this.matchTimer = window.setTimeout(() => {
      this.matchTimer = null;
      this.update((current) => ({
        ...current,
        websocketStale: true,
      }));
      void this.loadMatches();
    }, MATCH_POLL_INTERVAL);
  }

  private scheduleStatusFallback() {
    this.clearTimer("status");

    this.statusTimer = window.setTimeout(() => {
      this.statusTimer = null;
      this.update((current) => ({
        ...current,
        websocketStale: true,
      }));
      void this.loadStatuses();
    }, STATUS_POLL_INTERVAL);
  }

  private scheduleAllianceFallback() {
    this.clearTimer("alliance");

    this.allianceTimer = window.setTimeout(() => {
      this.allianceTimer = null;
      this.update((current) => ({
        ...current,
        websocketStale: true,
      }));
      void this.loadAlliances();
    }, ALLIANCE_POLL_INTERVAL);
  }

  private clearTimer(
    kind: "match" | "status" | "alliance",
  ) {
    const timer =
      kind === "match"
        ? this.matchTimer
        : kind === "status"
          ? this.statusTimer
          : this.allianceTimer;

    if (timer !== null) {
      window.clearTimeout(timer);
    }

    if (kind === "match") {
      this.matchTimer = null;
    } else if (kind === "status") {
      this.statusTimer = null;
    } else {
      this.allianceTimer = null;
    }
  }
}
