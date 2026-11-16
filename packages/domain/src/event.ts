import type { TBAEvent } from "@fieldview/provider-tba/types";
import type { EventKey } from "./ids.js";

/** Canonical identity and core scheduling/location information for an event. */
export interface FieldViewEvent {
  /** Canonical TBA key, validated and branded at the provider boundary. */
  key: EventKey;
  year: TBAEvent["year"];
  name: TBAEvent["name"];
  /** Event-local code, such as "cthar". */
  eventCode?: TBAEvent["event_code"] | null;
  /** Calendar date in YYYY-MM-DD form, not a UTC timestamp. */
  startDate?: TBAEvent["start_date"] | null;
  /** Calendar date in YYYY-MM-DD form, not a UTC timestamp. */
  endDate?: TBAEvent["end_date"] | null;
  /** Required IANA timezone identifier; null upstream values must be resolved at ingestion. */
  timezone: NonNullable<TBAEvent["timezone"]>;
  city?: TBAEvent["city"];
  stateProv?: TBAEvent["state_prov"];
  country?: TBAEvent["country"];
  venue?: TBAEvent["location_name"];
  address?: TBAEvent["address"];
  website?: TBAEvent["website"];
}
