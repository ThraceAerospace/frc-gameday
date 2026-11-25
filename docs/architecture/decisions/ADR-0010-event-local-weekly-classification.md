# ADR-0010: Event-local weekly classification and home-page projection

- **Status:** Historical decision; event-local date semantics remain valid, while ownership, scheduling, and runtime activation are superseded by `2026-11-24-storage-and-polling-ownership.md`
- **Date:** 2026-11-20
- **Decision owners:** FieldView project

## Supersession

The 2026-11-24 storage and polling ownership decision supersedes this ADR's EventScheduler ownership, daily publication cadence, EventRuntime lifecycle mutation, and Durable Object alarm batching. The current implementation uses a dedicated Monday weekly-projection Workflow, publishes one canonical `events-this-week` record, and leaves event lifecycle eligibility to the polling coordinator at each dispatch. The date-only inclusive overlap rules and event-local IANA timezone semantics below remain authoritative.

## Context

The home page needs a reliable list of events occurring during the current calendar week. Computing this list during a Next.js request would require event discovery, local date filtering, and potentially a fan-out to EventRuntime snapshots. That work delays the initial page response and duplicates scheduling logic in the presentation tier.

TBA event `start_date` and `end_date` are date-only values. They are not timestamps and do not identify a time of day. Events also have their own IANA `timezone`, which must govern the local calendar date used for weekly classification.

## Decision

1. **EventScheduler owns weekly classification and publication.** It evaluates the retained current-season event directory in a backend daily job, invoked by a Cloudflare Cron Trigger at 16:00 UTC. Next.js and browsers consume the published projection; they do not discover or classify the weekly event set.
2. **The calendar week is Monday through Sunday, inclusive.** For each event, determine the current calendar date in that event's own IANA timezone, then calculate that local date's Monday 00:00 through Sunday 23:59:59 week.
3. **Event dates are inclusive full calendar days.** `start_date` is the beginning of that date (00:00:00) and `end_date` is the end of that date (23:59:59) in the event's timezone. No provider start/end timestamps are required or inferred. A Friday-Sunday event occupies all of Friday, Saturday, and Sunday.
4. **Classification uses date-range overlap, not lifecycle status.** An event is occurring this week exactly when its inclusive date range overlaps the event-local Monday-Sunday date range:
   - `event.start_date <= week_end_date`
   - `event.end_date >= week_start_date`
   Date-only values are compared as validated ISO `YYYY-MM-DD` strings. Invalid dates, reversed ranges, or invalid/missing timezones are not classified.
5. **EventScheduler ensures EventRuntime ownership for every classified event.** It creates or updates the corresponding EventRuntime lifecycle state. If the event ended earlier in the same week, the runtime may be marked expired to avoid unnecessary polling, but the runtime remains registered and the event remains in the weekly projection.
6. **Work is bounded and resumable.** The daily pass processes at most ten events per alarm batch, persists its cursor, and publishes the new projection only after the pass completes. It reuses the existing EventScheduler and EventRuntime; no additional Durable Object class is introduced.
7. **The Worker exposes a read-only projection** at `GET /events/this-week`. It returns the completed projection and its evaluation date/time with cache headers. Reads do not trigger discovery, classification, or provider acquisition.
8. **Live enrichment is separate from the projection.** Current match status, webcast, and other rapidly changing information must not block the initial home-page event list. Consumers may load or refresh that enrichment independently.
9. **Conditional caching is a future optimization, not a current endpoint requirement.** The application may adopt ETags or equivalent validators on its own read endpoints in the mature architecture where they materially improve revalidation. The current home-page integration uses the projection's existing cache headers and the Next.js Data Cache; it does not require FieldView-owned endpoint ETags.

## Consequences

- Events spanning Friday-Sunday, Thursday-Saturday, or any other dates are included when their inclusive date ranges overlap their own local Monday-Sunday week.
- Events in different timezones can have different local dates and week boundaries at the same UTC instant. Each event is evaluated independently.
- Daylight-saving transitions do not alter the date-only overlap calculation; timezone conversion is used only to determine the event-local current calendar date.
- The published projection can be cached by Next.js and clients without requiring them to repeat event discovery or filtering.
- The daily scheduler pass is intentionally not a real-time boundary trigger. The Cron Trigger invokes a bounded discovery/classification run once per day without enabling continuous hourly polling. If the weekly pass needs multiple batches, EventScheduler resumes it through its alarm. It recomputes the projection on its daily cadence; the event-local timezone is nevertheless used for every classification.

## Validation requirements

- Friday-Sunday dates are included for the entire inclusive range.
- Thursday-Saturday events are included in the week containing Friday and Saturday.
- An event ending Sunday is included through Sunday; an event beginning the following Monday is not included in the preceding week.
- Week boundaries are calculated independently for each event timezone, including dates near UTC midnight and daylight-saving transitions.
- Invalid or reversed date ranges and invalid timezones are excluded.
- Processing is bounded, resumable, idempotent for unchanged EventRuntime lifecycle state, and publishes only a completed projection.
- Public projection reads are read-only and do not trigger provider requests.
- The home page consumes `/events/this-week` directly and does not fan out to individual EventRuntime snapshots for its initial event list.
- FieldView-owned endpoint ETags remain deferred; future conditional revalidation should be introduced selectively after measuring cache behavior.
