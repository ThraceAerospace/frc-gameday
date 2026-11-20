import type { TBADistrict, TBADistrictAdvancementResponse, TBADistrictRanking, TBATeam, TBAEvent } from "@fieldview/provider-tba/types";
import type { FieldViewDistrict, FieldViewDistrictDirectory, FieldViewDistrictSnapshot } from "../district.js";
import type { FieldViewSourceMetadata } from "../source-metadata.js";

export interface NormalizeFieldViewDistrictDirectoryInput {
  year: number;
  tba_districts?: TBADistrict[] | null;
  sources: FieldViewSourceMetadata;
}

/** Preserve the TBA district list and attach only its own provenance. */
export function normalizeFieldViewDistrictDirectory(
  input: NormalizeFieldViewDistrictDirectoryInput,
): FieldViewDistrictDirectory {
  if (input.tba_districts && input.tba_districts.some((district) => district.year !== input.year)) {
    throw new Error("District directory contains a district from a different year");
  }
  const source = input.sources.tba_districts;
  const districts = input.tba_districts === undefined
    ? undefined
    : input.tba_districts === null
      ? null
      : input.tba_districts.map((district) => ({
          ...district,
          sources: source === undefined ? {} : { tba_districts: source },
        }));
  return {
    year: input.year,
    sources: input.sources,
    ...(districts === undefined ? {} : { districts }),
  };
}

export interface NormalizeFieldViewDistrictSnapshotInput {
  district_key: string;
  year: number;
  tba_district?: TBADistrict | null;
  tba_teams?: TBATeam[] | null;
  tba_events?: TBAEvent[] | null;
  tba_rankings?: TBADistrictRanking[] | null;
  tba_advancement?: TBADistrictAdvancementResponse | null;
  sources: FieldViewSourceMetadata;
}

/** Compose independently acquired district resources without rewriting provider fields. */
export function normalizeFieldViewDistrictSnapshot(
  input: NormalizeFieldViewDistrictSnapshotInput,
): FieldViewDistrictSnapshot {
  if (input.tba_district && (
    input.tba_district.key !== input.district_key ||
    input.tba_district.year !== input.year
  )) {
    throw new Error("District record does not match the requested district identity");
  }
  const districtSource = input.sources.tba_district;
  const district: FieldViewDistrict | null | undefined = input.tba_district === undefined
    ? undefined
    : input.tba_district === null
      ? null
      : {
          ...input.tba_district,
          sources: districtSource === undefined ? {} : { tba_district: districtSource },
        };
  return {
    district_key: input.district_key,
    year: input.year,
    sources: input.sources,
    ...(district === undefined ? {} : { district }),
    ...(input.tba_teams === undefined ? {} : { teams: input.tba_teams }),
    ...(input.tba_events === undefined ? {} : { events: input.tba_events }),
    ...(input.tba_rankings === undefined ? {} : { rankings: input.tba_rankings }),
    ...(input.tba_advancement === undefined ? {} : { advancement: input.tba_advancement }),
  };
}
