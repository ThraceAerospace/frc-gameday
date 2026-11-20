import type { TBADistrict, TBADistrictAdvancementResponse, TBADistrictRanking, TBATeam, TBAEvent } from "@fieldview/provider-tba/types";
import type { FieldViewSourceMetadata } from "./source-metadata.js";

/** Canonical district object retaining the complete, unchanged TBA district record. */
export interface FieldViewDistrict extends TBADistrict {
  sources: FieldViewSourceMetadata;
}

/** Current-season district directory, including resource-level provenance. */
export interface FieldViewDistrictDirectory {
  year: number;
  districts: FieldViewDistrict[] | null;
  sources: FieldViewSourceMetadata;
}

/**
 * Canonical district aggregate. Each collection remains an independent
 * resource: absent means not acquired, null means explicitly unavailable,
 * and an empty array means successfully acquired with no records.
 */
export interface FieldViewDistrictSnapshot {
  district_key: string;
  year: number;
  district?: FieldViewDistrict | null;
  teams?: TBATeam[] | null;
  events?: TBAEvent[] | null;
  rankings?: TBADistrictRanking[] | null;
  advancement?: TBADistrictAdvancementResponse | null;
  sources: FieldViewSourceMetadata;
}
