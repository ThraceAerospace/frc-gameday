import type { components } from "./generated.js";

type Schemas = components["schemas"];
type GeneratedStatboticsMatch = Schemas["FieldViewStatboticsMatch"];

export type StatboticsTeam = Schemas["FieldViewStatboticsTeam"];
export type StatboticsTeamYear = Schemas["FieldViewStatboticsTeamYear"];
export type StatboticsTeamEvent = Schemas["FieldViewStatboticsTeamEvent"];

/**
 * Explicitly type the per-team EPA component fields returned by Statbotics.
 * The upstream OpenAPI schema currently leaves these game-specific fields
 * behind an unknown-valued index signature.
 */
export type StatboticsMatchEPA =
  NonNullable<NonNullable<GeneratedStatboticsMatch["epas"]>[string]> & {
    comp_0_epa?: number | null;
    comp_1_epa?: number | null;
    comp_2_epa?: number | null;
    comp_3_epa?: number | null;
    comp_4_epa?: number | null;
    comp_5_epa?: number | null;
    comp_6_epa?: number | null;
    comp_7_epa?: number | null;
    comp_8_epa?: number | null;
    comp_9_epa?: number | null;
  };

/**
 * Explicit game-specific result fields supplied by Statbotics. Optional and
 * nullable forms follow the provider's partial-response behavior.
 */
export type StatboticsMatchResult =
  NonNullable<GeneratedStatboticsMatch["result"]> & {
    red_auto_points?: number | null;
    blue_auto_points?: number | null;
    red_teleop_points?: number | null;
    blue_teleop_points?: number | null;
    red_endgame_points?: number | null;
    blue_endgame_points?: number | null;
    red_energized_rp?: boolean | null;
    blue_energized_rp?: boolean | null;
    red_supercharged_rp?: boolean | null;
    blue_supercharged_rp?: boolean | null;
    red_traversal_rp?: boolean | null;
    blue_traversal_rp?: boolean | null;
    red_tiebreaker_points?: number | null;
    blue_tiebreaker_points?: number | null;
    red_auto_fuel?: number | null;
    blue_auto_fuel?: number | null;
    red_auto_tower?: number | null;
    blue_auto_tower?: number | null;
    red_transition_fuel?: number | null;
    blue_transition_fuel?: number | null;
    red_first_shift_fuel?: number | null;
    blue_first_shift_fuel?: number | null;
    red_second_shift_fuel?: number | null;
    blue_second_shift_fuel?: number | null;
    red_endgame_fuel?: number | null;
    blue_endgame_fuel?: number | null;
    red_endgame_tower?: number | null;
    blue_endgame_tower?: number | null;
    red_rp_1?: boolean | null;
    blue_rp_1?: boolean | null;
    red_rp_2?: boolean | null;
    blue_rp_2?: boolean | null;
    red_rp_3?: boolean | null;
    blue_rp_3?: boolean | null;
  };

export type StatboticsMatch = Omit<
  GeneratedStatboticsMatch,
  "result" | "pre_epas" | "epas"
> & {
  result?: StatboticsMatchResult;
  pre_epas?: Record<string, StatboticsMatchEPA>;
  epas?: Record<string, StatboticsMatchEPA>;
};

export type StatboticsPrediction = NonNullable<StatboticsMatch["pred"]>;
export type StatboticsRecordLine = NonNullable<NonNullable<StatboticsTeamEvent["record"]>["qual"]>;
export type StatboticsTeamRecord = NonNullable<StatboticsTeamEvent["record"]>;
export type StatboticsEpaProfile = NonNullable<StatboticsTeamYear["epa"]>;
export type StatboticsMatchStatus = "loading" | "ready" | "unavailable";
