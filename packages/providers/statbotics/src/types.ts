import type { components } from "./generated.js";

type Schemas = components["schemas"];
export type StatboticsMatch = Schemas["FieldViewStatboticsMatch"];
export type StatboticsTeam = Schemas["FieldViewStatboticsTeam"];
export type StatboticsTeamYear = Schemas["FieldViewStatboticsTeamYear"];
export type StatboticsTeamEvent = Schemas["FieldViewStatboticsTeamEvent"];
export type StatboticsPrediction = NonNullable<StatboticsMatch["pred"]>;
/** One team's EPA record in a Statbotics match's pre- or post-match EPA map. */
export type StatboticsMatchEPA = NonNullable<NonNullable<StatboticsMatch["epas"]>[string]>;
/** Result object returned in the Statbotics match resource. */
export type StatboticsMatchResult = NonNullable<StatboticsMatch["result"]>;
/** @deprecated Prefer the resource-specific StatboticsMatchEPA name. */
export type StatboticsEPA = StatboticsMatchEPA;
export type StatboticsRecordLine = NonNullable<NonNullable<StatboticsTeamEvent["record"]>["qual"]>;
export type StatboticsTeamRecord = NonNullable<StatboticsTeamEvent["record"]>;
export type StatboticsEpaProfile = NonNullable<StatboticsTeamYear["epa"]>;
export type StatboticsMatchStatus = "loading" | "ready" | "unavailable";
