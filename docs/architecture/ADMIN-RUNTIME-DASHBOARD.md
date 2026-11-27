# Runtime admin dashboard

The private runtime dashboard is available at `/admin/runtime` in the Next.js application.

## Configuration

Configure these values in the Next.js server environment:

- `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL`: base URL of the FieldView Worker runtime.
- `RUNTIME_ADMIN_TOKEN`: server-only bearer token accepted by the Worker runtime.
- `FIELDVIEW_ADMIN_ACCESS_TOKEN`: a separate, server-only password used to authenticate dashboard requests.

The dashboard access token must be different from `RUNTIME_ADMIN_TOKEN`. The browser sends only the dashboard access token to the Next.js route handler. The route handler validates it and then uses the server-only runtime token to call the Worker. Neither server-only token is rendered into the page or sent to the browser.

For local development, keep `FIELDVIEW_ADMIN_ACCESS_TOKEN` in the web app's ignored local environment file (for example, `apps/web/.env.local`). Restart Next.js after changing environment variables.

## What is monitored

- Registered EventRuntime and TeamRuntime instances.
- Resource status, revision, last successful fetch, last attempt, expiry, HTTP status, webhook time when present, and recorded errors.
- Workflow run records and polling-coordinator status; there are no per-runtime alarm deadlines or local task queues.
- Provider/resource-specific labels for EventRuntime resources and TeamRuntime identity, district, season-event, media, Statbotics, and FRC Colors endpoints.
- Record counts, included/excluded counts, data shape, HTTP diagnostics, and EPA-bearing Statbotics match counts where the raw provider payload exposes those fields.
- Authenticated operational controls for direct event/team refresh, individual resource refresh, Statbotics refresh, analytics recalculation, team/event seeding, and discovery refresh. There are no global scheduler start/stop controls.
- Provider endpoint freshness and acquisition status, plus Workflow execution records. The polling coordinator owns cadence and dispatch; entity Durable Objects do not schedule alarms.
- The single shared Multiplexer connection and subscription counts.

The command center refreshes its compact system overview every fifteen seconds. Event and team directories use a server-side, paginated search over registered keys plus the selected year's cached TBA discovery snapshot rather than filtering only the overview sample. When a year's discovery snapshot is absent, an explicit "Discover season" action fetches the TBA event and team discovery resources (two conditional provider requests) and retains the resulting year-specific caches. Selecting an entity opens its own command center, addressable with an `?event=<key>&year=<year>` or `?team=<key>&year=<year>` query parameter. The entity view groups canonical analytics, provider resources, Workflow records, and entity-specific actions. Authenticated operations can directly refresh all event resources, refresh an individual provider resource, refresh Statbotics event matches, force EventRuntime analytics recalculation, refresh or seed a team, explicitly recalculate TeamRuntime season analytics, and refresh discovery. Mutations are dispatched through the Worker admin router; the browser never receives the Worker service token.

The home page deliberately reports sampled coverage separately from registered inventory totals. Its quick missing-resource and missing-analytics counts describe only the event/team objects returned in the current overview sample (up to 250 of each type). The **Full-season coverage audit** is a separate resumable scan over the selected year's complete TBA season discovery. TBA's `/teams/{year}/{page_num}` endpoint is paginated in groups of 500; discovery must walk pages sequentially until a short final page and retain each page's ETag and payload. A team directory is complete only when pagination reaches a page with fewer than 500 teams; no legacy single-page cache is accepted. The year-scoped `/events/{year}` endpoint supplies the full event list. The audit reads runtime Durable Object state only; it makes no provider API requests. The dashboard automatically processes batches of 20 sequential runtime reads, persists the cursor and counts as a durable System Records operation, and resumes an interrupted audit when the page is reopened. The audit cursor and counts are persisted directly in System Records D1 and resume after interruption. Before fetching runtime state, it checks FieldView's runtime-registration indexes; unregistered teams are counted as missing without creating thousands of empty TeamRuntime objects just to inspect them. It reports all TBA-listed events, how many have already happened versus are active/upcoming, the complete season team count and page count, missing event/team runtimes, incomplete configured resource sets, missing event analytics, and read errors. A completed audit is exact for the TBA season inventory snapshot, not a Cloudflare account-wide Durable Object inventory. Team season discovery is complete only after pagination reaches a page with fewer than 500 teams.

## Inventory semantics and limits

FieldView maintains a lightweight registry of event and team runtime identities. The registry is stored directly in System Records D1. Current-year event discovery registers event keys, and public/internal team and event routes register requested objects. The dashboard queries the corresponding Durable Object state; it does not enumerate Cloudflare's account-wide Durable Object platform inventory, and it cannot display objects never registered through FieldView. Runtime registration is operational metadata, not Discovery data. The overview currently returns at most 250 event and 250 team objects per refresh and indicates when that cap is exceeded.

A registered object may be reachable while having no acquired provider resources yet. That is distinct from an unavailable or failed provider resource.
