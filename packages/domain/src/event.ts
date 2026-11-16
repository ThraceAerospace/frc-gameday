import type { EventKey } from "./ids.js";

/** Canonical identity and core scheduling/location information for an event. */
export interface FieldViewEvent {
  /** Canonical TBA key, for example "2026cthar". */
  key: EventKey;
  year: number;
  name: string;
  /** Event-local code, such as "cthar". */
  eventCode?: string | null;
  /** Calendar date in YYYY-MM-DD form, not a UTC timestamp. */
  startDate?: string | null;
  /** Calendar date in YYYY-MM-DD form, not a UTC timestamp. */
  endDate?: string | null;
  /** Required IANA timezone identifier, such as "America/New_York". */
  timezone: string;
  city?: string | null;
  stateProv?: string | null;
  country?: string | null;
  venue?: string | null;
  address?: string | null;
  website?: string | null;
}
