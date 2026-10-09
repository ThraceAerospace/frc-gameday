"use client";

import {
  getLastMatch,
  getNextMatch,
  sortMatches,
} from "@/lib/tba/matchUtils";
import type { StatboticsMatch } from "@/lib/statbotics/types";
import type {
  TBAEliminationAlliance,
  TBAEvent,
  TBAEventTeamStatuses,
  TBAEventOPRs,
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
  oprs: TBAEventOPRs | null;
  loading: boolean;
  error: Error | null;
  websocketStatus: EventWebSocketStatus;
  websocketStale: boolean;
  upcomingMatchKey: string | null;
  upcomingMatchTeamKeys: string[];
  statboticsMatches: Record<string, { data: StatboticsMatch | null; status: "loading" | "ready" | "unavailable" }>;
};

type Listener = (snapshot: EventStateSnapshot) => void;

const MATCH_POLL_INTERVAL = 5 * 60_000;
const STATUS_POLL_INTERVAL = 5 * 60_000;
const ALLIANCE_POLL_INTERVAL = 15 * 60_000;
const AUTHORITATIVE_REFETCH_DELAY = 65_000;
const STATBOTICS_RESULT_REFRESH_DELAY = 3 * 60_000;

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
    oprs: null,
    loading: true,
    error: null,
    websocketStatus: "disconnected",
    websocketStale: false,
    upcomingMatchKey: null,
    upcomingMatchTeamKeys: [],
    statboticsMatches: {},
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
  private oprTimer: number | null = null;

  private eventRequest = 0;
  private teamsRequest = 0;
  private matchesRequest = 0;
  private statusesRequest = 0;
  private alliancesRequest = 0;
  private oprsRequest = 0;

  private readonly authoritativeTimers = new Map<string, number>();
  private readonly statboticsRequests = new Map<string, number>();
  private readonly statboticsSignatures = new Map<string, string>();
  private readonly statboticsRefreshTimers = new Map<string, number>();

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
    void this.loadOprs();

    this.scheduleMatchFallback();
    this.scheduleStatusFallback();
    this.scheduleAllianceFallback();
    this.scheduleOprsFallback();
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
    this.clearTimer("oprs");

    for (const timer of this.authoritativeTimers.values()) {
      window.clearTimeout(timer);
    }

    this.authoritativeTimers.clear();
    for (const timer of this.statboticsRefreshTimers.values()) window.clearTimeout(timer);
    this.statboticsRefreshTimers.clear();
    // Re-evaluate the current and last match when this EventState starts again.
    this.statboticsSignatures.clear();

    for (const [matchKey, request] of this.statboticsRequests) {
      this.statboticsRequests.set(matchKey, request + 1);
    }
    this.update((current) => ({
      ...current,
      statboticsMatches: Object.fromEntries(
        Object.entries(current.statboticsMatches).map(([matchKey, value]) => [
          matchKey,
          !value.data && value.status === "loading"
            ? { data: null, status: "unavailable" as const }
            : value,
        ]),
      ),
    }));
  }

  reloadAll() {
    void this.loadEvent();
    void this.loadTeams();
    this.reloadMatches();
    this.reloadStatuses();
    this.reloadAlliances();
    this.reloadOprs();
  }

  reloadMatches() {
    void this.loadMatches();
    this.resetAuthoritativeTimer("matches");
  }

  reloadStatuses() {
    void this.loadStatuses();
    this.resetAuthoritativeTimer("statuses");
  }

  reloadAlliances() {
    void this.loadAlliances();
    this.resetAuthoritativeTimer("alliances");
  }

  reloadOprs() {
    void this.loadOprs();
    this.resetAuthoritativeTimer("oprs");
  }

  private ensureStatboticsMatch(matchKey: string, resultSignature: string) {
    const previousSignature = this.statboticsSignatures.get(matchKey);
    this.statboticsSignatures.set(matchKey, resultSignature);

    const resultIsFinal = resultSignature.startsWith("final:");
    if (previousSignature === undefined) {
      void this.fetchStatboticsMatch(matchKey, resultIsFinal);
      return;
    }

    if (previousSignature === resultSignature) {
      const existing = this.snapshot.statboticsMatches[matchKey];
      if (!existing || (existing.status === "unavailable" && !existing.data)) {
        void this.fetchStatboticsMatch(matchKey, resultIsFinal);
      }
      return;
    }

    if (resultIsFinal) {
      const existingTimer = this.statboticsRefreshTimers.get(matchKey);
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        this.statboticsRefreshTimers.delete(matchKey);
        void this.fetchStatboticsMatch(matchKey, true);
      }, STATBOTICS_RESULT_REFRESH_DELAY);
      this.statboticsRefreshTimers.set(matchKey, timer);
    } else {
      void this.fetchStatboticsMatch(matchKey, false);
    }
  }

  private async fetchStatboticsMatch(matchKey: string, refresh: boolean) {
    const request = (this.statboticsRequests.get(matchKey) ?? 0) + 1;
    this.statboticsRequests.set(matchKey, request);
    this.update((current) => ({
      ...current,
      statboticsMatches: {
        ...current.statboticsMatches,
        [matchKey]: {
          data: current.statboticsMatches[matchKey]?.data ?? null,
          status: current.statboticsMatches[matchKey]?.data ? "ready" : "loading",
        },
      },
    }));

    try {
      const endpoint = "/api/statbotics/match/" + encodeURIComponent(matchKey) +
        (refresh ? "?refresh=1" : "");
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error(`Statbotics request failed: ${response.status}`);
      const data = await response.json() as StatboticsMatch;
      if (this.stopped || this.statboticsRequests.get(matchKey) !== request) return;
      this.update((current) => ({
        ...current,
        statboticsMatches: {
          ...current.statboticsMatches,
          [matchKey]: { data, status: "ready" },
        },
      }));
    } catch {
      if (this.stopped || this.statboticsRequests.get(matchKey) !== request) return;
      this.update((current) => ({
        ...current,
        statboticsMatches: {
          ...current.statboticsMatches,
          [matchKey]: {
            data: current.statboticsMatches[matchKey]?.data ?? null,
            status: current.statboticsMatches[matchKey]?.data ? "ready" : "unavailable",
          },
        },
      }));
    }
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

      const eventNextMatch = getNextMatch(matches);
      const eventLastMatch = getLastMatch(matches);
      const relevantStatboticsKeys = new Set(
        [eventNextMatch?.key, eventLastMatch?.key].filter(
          (key): key is string => Boolean(key),
        ),
      );
      this.update((current) => ({
        ...current,
        matches,
        eventNextMatch,
        eventLastMatch,
        statboticsMatches: Object.fromEntries(
          Object.entries(current.statboticsMatches).filter(([key]) =>
            relevantStatboticsKeys.has(key),
          ),
        ),
      }));

      // Statbotics match data is event-domain state. Keep predictions for the
      // current and most recently completed matches warm for every View.
      for (const match of [eventNextMatch, eventLastMatch]) {
        if (!match) continue;
        const resultPosted =
          typeof match.alliances.red.score === "number" &&
          match.alliances.red.score >= 0 &&
          typeof match.alliances.blue.score === "number" &&
          match.alliances.blue.score >= 0;
        const signature = `${resultPosted ? "final" : "pending"}:${match.alliances.red.score}:${match.alliances.blue.score}:${match.actual_time ?? ""}`;
        this.ensureStatboticsMatch(match.key, signature);
      }

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

  private async loadOprs() {
    const request = ++this.oprsRequest;

    try {
      const response = await fetch(
        `/api/event/${encodeURIComponent(this.eventKey)}/oprs`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (request !== this.oprsRequest || this.stopped) {
        return;
      }

      this.update((current) => ({
        ...current,
        oprs: data && typeof data === "object" ? (data as TBAEventOPRs) : null,
      }));

      this.scheduleOprsFallback();
    } catch (error) {
      if (request !== this.oprsRequest || this.stopped) {
        return;
      }

      console.error("[EventState] OPRs request failed", error);
      this.scheduleOprsFallback();
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
      message.eventKey !== this.eventKey
    ) {
      return;
    }

    this.update((current) =>
      current.websocketStale
        ? { ...current, websocketStale: false }
        : current,
    );

    switch (message.messageType) {
      case "upcoming_match": {
        const matchKey =
          typeof message.messageData?.match_key === "string"
            ? message.messageData.match_key
            : null;

        const teamKeys = Array.isArray(
          message.messageData?.team_keys,
        )
          ? message.messageData.team_keys.filter(
              (team): team is string => typeof team === "string",
            )
          : [];

        this.update((current) => ({
          ...current,
          upcomingMatchKey: matchKey,
          upcomingMatchTeamKeys: teamKeys,
        }));

        this.reloadMatches();
        break;
      }

      case "match_score": {
        const matchKey =
          typeof message.messageData?.match_key === "string"
            ? message.messageData.match_key
            : null;

        this.update((current) =>
          matchKey &&
          current.upcomingMatchKey === matchKey
            ? {
                ...current,
                upcomingMatchKey: null,
                upcomingMatchTeamKeys: [],
              }
            : current,
        );
        this.reloadMatches();
        this.reloadStatuses();
        this.reloadAlliances();
        this.reloadOprs();
        break;
      }

      case "match_video":
        this.reloadMatches();
        break;

      case "alliance_selection":
        this.reloadAlliances();
        break;

      default:
        /*
         * Full-refresh webhook types and unknown future types
         * intentionally go through reloadAll(). Each independent
         * reload resets its own authoritative timer.
         */
        this.reloadAll();
        break;
    }
  };

  private resetAuthoritativeTimer(
    resource: "matches" | "statuses" | "alliances" | "oprs",
  ) {
    const existing =
      this.authoritativeTimers.get(resource);

    if (existing !== undefined) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(() => {
      this.authoritativeTimers.delete(resource);

      if (this.stopped) {
        return;
      }

      /*
       * Keep the watchdog alive. A webhook-triggered reload
       * will replace this timer and restart its 65s countdown.
       */
      this.resetAuthoritativeTimer(resource);

      /*
       * Use the underlying load directly so the authoritative
       * reconciliation does not itself reset the watchdog.
       * The normal TBA client/cache path determines whether
       * this reaches Redis or upstream.
       */
      switch (resource) {
        case "matches":
          void this.loadMatches();
          break;

        case "statuses":
          void this.loadStatuses();
          break;

        case "alliances":
          void this.loadAlliances();
          break;

        case "oprs":
          void this.loadOprs();
          break;
      }
    }, AUTHORITATIVE_REFETCH_DELAY);

    this.authoritativeTimers.set(resource, timer);
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

  private scheduleOprsFallback() {
    this.clearTimer("oprs");

    this.oprTimer = window.setTimeout(() => {
      this.oprTimer = null;
      this.update((current) => ({
        ...current,
        websocketStale: true,
      }));
      void this.loadOprs();
    }, STATUS_POLL_INTERVAL);
  }

  private clearTimer(
    kind: "match" | "status" | "alliance" | "oprs",
  ) {
    const timer =
      kind === "match"
        ? this.matchTimer
        : kind === "status"
          ? this.statusTimer
          : kind === "alliance"
            ? this.allianceTimer
            : this.oprTimer;

    if (timer !== null) {
      window.clearTimeout(timer);
    }

    if (kind === "match") {
      this.matchTimer = null;
    } else if (kind === "status") {
      this.statusTimer = null;
    } else if (kind === "alliance") {
      this.allianceTimer = null;
    } else {
      this.oprTimer = null;
    }
  }
}
