# ADR-0010: Event-local weekly classification and home-page projection

- **Status:** Accepted for date semantics; scheduling and runtime-registration details clarified by later decisions
- **Date:** 2026-11-20
- **Decision owners:** FieldView project

## Context

The home page needs a reliable list of events occurring during the current calendar week. TBA event `start_date` and `end_date` are date-only values, not timestamps. Each event's IANA `timezone` governs the local calendar date used for weekly classification.

## Decision

1. A backend WeeklyEventProjection Workflow owns weekly classification and publication. It evaluates the retained current-season event directory; Next.js and browsers consume the published projection and do not independently discover or classify the weekly event set.
2. The calendar week is Monday through Sunday, inclusive.
3. For each event, determine the current calendar date in that event's own IANA timezone, then calculate that local date's Monday 00:00 through Sunday 23:59:59 week.
4. Event dates are inclusive full calendar days. `start_date` begins at 00:00:00 and `end_date` ends at 23:59:59 in the event timezone. No provider start/end timestamps are inferred.
5. Classification uses inclusive date-range overlap:
   - `event.start_date <= week_end_date`
   - `event.end_date >= week_start_date`
6. Date-only values are compared as validated ISO `YYYY-MM-DD` strings. Invalid dates, reversed ranges, or invalid/missing timezones are not classified.
7. The Workflow publishes one canonical `events-this-week` projection record. The polling coordinator independently evaluates event lifecycle eligibility at dispatch time; weekly membership does not itself cause a runtime refresh.
8. Runtime registration and first-time provider bootstrap are owned by the explicit initialization workflows, not by the weekly classification projection.
9. The read-only projection endpoint returns the completed projection and its evaluation metadata. Reads do not trigger discovery, classification, provider acquisition, or runtime registration.
10. Live enrichment such as match status and webcast data is separate from the weekly candidate projection and must not block the initial home-page list.

## Consequences

Events spanning Friday-Sunday, Thursday-Saturday, or other dates are included when their inclusive ranges overlap their own local Monday-Sunday week. Events in different timezones can have different local dates and week boundaries at the same UTC instant. Daylight-saving transitions do not change the date-only overlap calculation.

The weekly projection is a discovery/read model, not a canonical EventState/TeamState snapshot and not a provider acquisition scheduler.

## Validation

Validate inclusive date ranges, timezone-specific week boundaries near UTC midnight and daylight-saving transitions, invalid/reversed ranges, idempotent projection publication, and read-only projection access. Validate polling eligibility separately through the polling coordinator contract.
