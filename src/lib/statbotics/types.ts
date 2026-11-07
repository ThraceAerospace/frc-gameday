import type { components } from "./generated";

type Schemas = components["schemas"];

export type StatboticsMatch = Schemas["FieldViewStatboticsMatch"];
export type StatboticsTeam = Schemas["FieldViewStatboticsTeam"];
export type StatboticsTeamEvent = Schemas["FieldViewStatboticsTeamEvent"];
export type StatboticsTeamYear = Schemas["FieldViewStatboticsTeamYear"];
export type StatboticsPrediction = Schemas["FieldViewStatboticsPrediction"];
export type StatboticsEPA = Schemas["FieldViewStatboticsMatchEPA"];
export type StatboticsRecordLine = Schemas["FieldViewStatboticsRecordLine"];
export type StatboticsTeamRecord = Schemas["FieldViewStatboticsTeamRecord"];
export type StatboticsEpaProfile = Schemas["FieldViewStatboticsEpaProfile"];

export type StatboticsMatchStatus = "loading" | "ready" | "unavailable";
