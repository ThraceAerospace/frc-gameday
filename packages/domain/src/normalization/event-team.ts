import type { TBAEventOPRs, TBATeamEventStatus } from "@fieldview/provider-tba/types";
import type { FieldViewEventTeam } from "../event.js";
import type { EventKey, TeamKey } from "../ids.js";

/** Independent source resources used to construct one event-team association. */
export interface NormalizeFieldViewEventTeamInput {
  event_key: EventKey;
  team_key: TeamKey;
  /** Explicit null is retained; absence means no status value was supplied. */
  tba_status?: TBATeamEventStatus | null;
  /** Event-scoped resource; values are associated by the unchanged TBA team key. */
  tba_event_oprs?: TBAEventOPRs;
}

/**
 * Compose an event-team domain object from independently acquired resources.
 *
 * This is association only: it does not mutate either input, invent defaults,
 * or reinterpret TBA status/OPR values. Explicit null status is preserved;
 * absent status and absent metric keys remain absent.
 */
export function normalizeFieldViewEventTeam(
  input: NormalizeFieldViewEventTeamInput,
): FieldViewEventTeam {
  const { event_key, team_key, tba_status, tba_event_oprs } = input;
  const opr = tba_event_oprs?.oprs?.[team_key];
  const dpr = tba_event_oprs?.dprs?.[team_key];
  const ccwm = tba_event_oprs?.ccwms?.[team_key];

  return {
    event_key,
    team_key,
    ...(tba_status === undefined ? {} : { tba_status }),
    ...(opr === undefined ? {} : { opr }),
    ...(dpr === undefined ? {} : { dpr }),
    ...(ccwm === undefined ? {} : { ccwm }),
  };
}
