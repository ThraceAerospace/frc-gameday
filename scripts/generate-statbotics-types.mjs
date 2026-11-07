import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.STATBOTICS_OPENAPI_URL?.trim() || "https://api.statbotics.io/openapi.json";
const i = { type: "integer" };
const ns = { anyOf: [{ type: "number" }, { type: "null" }] };
const ni = { anyOf: [{ type: "integer" }, { type: "null" }] };
const s = { anyOf: [{ type: "string" }, { type: "null" }] };
const b = { anyOf: [{ type: "boolean" }, { type: "null" }] };
const obj = (properties, additionalProperties = false) => ({ type: "object", properties, additionalProperties });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const fallbackSchemas = {
  FieldViewStatboticsRecordLine: obj({ wins:i, losses:i, ties:i, count:i, winrate:ns, rps:ns, rps_per_match:ns, rank:ni, num_teams:ni, alliance:s, is_captain:b }),
  FieldViewStatboticsTeamRecord: obj({ qual:ref("FieldViewStatboticsRecordLine"), elim:ref("FieldViewStatboticsRecordLine"), total:ref("FieldViewStatboticsRecordLine") }),
  FieldViewStatboticsEpaRanks: obj({
    total:obj({rank:ni,percentile:ns,team_count:ni}), country:obj({rank:ni,percentile:ns,team_count:ni}),
    state:obj({rank:ni,percentile:ns,team_count:ni}), district:obj({rank:ni,percentile:ns,team_count:ni}),
  }),
  FieldViewStatboticsEpaProfile: obj({
    total_points:ns, unitless:ns, norm:ns, breakdown:{type:"object",additionalProperties:ns},
    stats:{type:"object",additionalProperties:ns}, ranks:ref("FieldViewStatboticsEpaRanks"),
  }),
  FieldViewStatboticsTeam: obj({
    team:i,name:{type:"string"},country:s,state:s,district:s,rookie_year:ni,active:{type:"boolean"},
    last_active_year:ni,record:obj({wins:i,losses:i,ties:i,count:i,winrate:ns}),
    norm_epa:obj({current:ns,recent:ns,mean:ns,max:ns}),
  }),
  FieldViewStatboticsTeamYear: obj({
    team:i,year:i,name:{type:"string"},country:s,state:s,district:s,rookie_year:ni,
    epa:ref("FieldViewStatboticsEpaProfile"),record:ref("FieldViewStatboticsTeamRecord"),
    competing:obj({next_event_key:s,next_event_name:s,next_event_week:ni,next_event_start_date:s}),
  }),
  FieldViewStatboticsTeamEvent: obj({
    team:i,year:i,event:{type:"string"},time:i,team_name:{type:"string"},event_name:{type:"string"},
    country:s,state:s,district:s,type:{type:"string"},week:i,status:{type:"string"},first_event:{type:"boolean"},
    epa:ref("FieldViewStatboticsEpaProfile"),record:ref("FieldViewStatboticsTeamRecord"),
  }),
  FieldViewStatboticsPrediction: obj({
    winner:{anyOf:[{type:"string",enum:["red","blue","tie"]},{type:"null"}]},
    red_win_prob:ns,red_score:ns,blue_score:ns,
    red_energized_rp:ns,blue_energized_rp:ns,red_supercharged_rp:ns,blue_supercharged_rp:ns,
    red_traversal_rp:ns,blue_traversal_rp:ns,red_rp_1:ns,blue_rp_1:ns,red_rp_2:ns,blue_rp_2:ns,red_rp_3:ns,blue_rp_3:ns,
  },true),
  FieldViewStatboticsMatchEPA: obj({
    epa:ns,auto_epa:ns,teleop_epa:ns,endgame_epa:ns,rp_1_epa:ns,rp_2_epa:ns,rp_3_epa:ns,tiebreaker_epa:ns,
  },true),
  FieldViewStatboticsAlliance: obj({
    team_keys:{type:"array",items:i},surrogate_team_keys:{type:"array",items:i},dq_team_keys:{type:"array",items:i},
  }),
  FieldViewStatboticsMatch: obj({
    key:{type:"string"},year:i,event:{type:"string"},week:i,elim:{type:"boolean"},comp_level:{type:"string"},
    set_number:i,match_number:i,match_name:{type:"string"},time:i,predicted_time:ni,status:{type:"string"},video:s,
    alliances:obj({red:ref("FieldViewStatboticsAlliance"),blue:ref("FieldViewStatboticsAlliance")}),
    pred:ref("FieldViewStatboticsPrediction"),
    result:obj({winner:{anyOf:[{type:"string",enum:["red","blue","tie"]},{type:"null"}]},red_score:ns,blue_score:ns,red_no_foul:ns,blue_no_foul:ns},true),
    pre_epas:{type:"object",additionalProperties:ref("FieldViewStatboticsMatchEPA")},
    epas:{type:"object",additionalProperties:ref("FieldViewStatboticsMatchEPA")},
  }),
};

function generic(schema) {
  if (!schema || typeof schema !== "object") return true;
  if (schema.$ref || schema.oneOf || schema.anyOf || schema.allOf) return false;
  if (schema.type === "array") return generic(schema.items);
  return schema.type === "object" && (!schema.properties || !Object.keys(schema.properties).length);
}
function getMedia(spec, suffix) {
  const entry = Object.entries(spec.paths ?? {}).find(([path]) => path.endsWith(suffix));
  if (!entry) throw new Error(`OpenAPI path not found: ${suffix}`);
  const response = entry[1].get?.responses?.["200"] ?? entry[1].get?.responses?.["2XX"];
  const media = response?.content?.["application/json"];
  if (!media) throw new Error(`OpenAPI JSON response schema not found: ${suffix}`);
  return media;
}
function patchResponse(spec, suffix, schemaName, array = false) {
  const media = getMedia(spec, suffix);
  const schema = media.schema;
  if (array && schema?.type === "array" && generic(schema.items)) media.schema = { ...schema, items: ref(schemaName) };
  else if (!schema || generic(schema)) media.schema = array ? { type:"array",items:ref(schemaName) } : ref(schemaName);
}
function ensureNamedSchema(spec, suffix, fallbackName, array = false) {
  const media = getMedia(spec, suffix);
  const schema = array ? media.schema?.items : media.schema;
  if (!schema) throw new Error(`Response schema missing after fallback for ${suffix}`);
  if (schema.$ref) {
    const match = schema.$ref.match(/^#\/components\/schemas\/([^/]+)$/);
    if (!match) throw new Error(`Unsupported schema reference for ${suffix}: ${schema.$ref}`);
    return match[1];
  }
  const name = `FieldViewStatboticsUpstream${fallbackName.replace("FieldViewStatbotics", "")}`;
  spec.components.schemas[name] = schema;
  if (array) media.schema.items = ref(name);
  else media.schema = ref(name);
  return name;
}

async function main() {
  const response = await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`Statbotics OpenAPI fetch failed: HTTP ${response.status} (${url})`);
  const spec = await response.json();
  if (!spec?.paths || !spec?.components) throw new Error("Statbotics OpenAPI document is missing paths/components");
  spec.components.schemas ??= {};
  for (const [name,schema] of Object.entries(fallbackSchemas)) spec.components.schemas[name] ??= schema;

  patchResponse(spec,"/match/{match}","FieldViewStatboticsMatch");
  patchResponse(spec,"/matches","FieldViewStatboticsMatch",true);
  patchResponse(spec,"/team/{team}","FieldViewStatboticsTeam");
  patchResponse(spec,"/team_year/{team}/{year}","FieldViewStatboticsTeamYear");
  patchResponse(spec,"/team_years","FieldViewStatboticsTeamYear",true);
  patchResponse(spec,"/team_event/{team}/{event}","FieldViewStatboticsTeamEvent");
  patchResponse(spec,"/team_events","FieldViewStatboticsTeamEvent",true);

  const aliases = {
    StatboticsMatch: ensureNamedSchema(spec,"/match/{match}","FieldViewStatboticsMatch"),
    StatboticsTeam: ensureNamedSchema(spec,"/team/{team}","FieldViewStatboticsTeam"),
    StatboticsTeamYear: ensureNamedSchema(spec,"/team_year/{team}/{year}","FieldViewStatboticsTeamYear"),
    StatboticsTeamEvent: ensureNamedSchema(spec,"/team_event/{team}/{event}","FieldViewStatboticsTeamEvent"),
  };
  const typeFile = [
    'import type { components } from "./generated";',
    '',
    'type Schemas = components["schemas"];',
    ...Object.entries(aliases).map(([alias,name]) => `export type ${alias} = Schemas["${name}"];`),
    'export type StatboticsPrediction = NonNullable<StatboticsMatch["pred"]>;',
    'export type StatboticsEPA = NonNullable<NonNullable<StatboticsMatch["epas"]>[string]>;',
    'export type StatboticsRecordLine = NonNullable<NonNullable<StatboticsTeamEvent["record"]>["qual"]>;',
    'export type StatboticsTeamRecord = NonNullable<StatboticsTeamEvent["record"]>;',
    'export type StatboticsEpaProfile = NonNullable<StatboticsTeamYear["epa"]>;',
    'export type StatboticsMatchStatus = "loading" | "ready" | "unavailable";',
    '',
  ].join("\n");

  const dir=mkdtempSync(join(tmpdir(),"fieldview-statbotics-"));
  try {
    const file=join(dir,"openapi.json"); writeFileSync(file,JSON.stringify(spec));
    execFileSync(process.platform==="win32"?"npx.cmd":"npx",["openapi-typescript",file,"-o","src/lib/statbotics/generated.ts"],{stdio:"inherit"});
    writeFileSync("src/lib/statbotics/types.ts",typeFile);
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
