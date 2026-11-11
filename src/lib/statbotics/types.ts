import type { components } from "./generated";

type Schemas = components["schemas"];
export type StatboticsMatch = Schemas["FieldViewStatboticsMatch"];
export type StatboticsTeam = Schemas["FieldViewStatboticsTeam"];
export type StatboticsTeamYear = Schemas["FieldViewStatboticsTeamYear"];
export type StatboticsTeamEvent = Schemas["FieldViewStatboticsTeamEvent"];
export type StatboticsPrediction = NonNullable<StatboticsMatch["pred"]>;
export type StatboticsEPA = NonNullable<NonNullable<StatboticsMatch["epas"]>[string]>;
export type StatboticsRecordLine = NonNullable<NonNullable<StatboticsTeamEvent["record"]>["qual"]>;
export type StatboticsTeamRecord = NonNullable<StatboticsTeamEvent["record"]>;
export type StatboticsEpaProfile = NonNullable<StatboticsTeamYear["epa"]>;
export type StatboticsMatchStatus = "loading" | "ready" | "unavailable";
