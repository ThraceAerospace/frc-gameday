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

- Global EventScheduler enabled state, last run, and discovery errors.
- Registered EventRuntime and TeamRuntime instances.
- Resource status, revision, last successful fetch, last attempt, expiry, HTTP status, webhook time when present, and recorded errors.
- Task due time, interval, attempts, retry-on-failure policy when exposed, and webhook-triggered authoritative refetch times.
- Provider/resource-specific labels for EventRuntime resources and TeamRuntime identity, district, season-event, media, Statbotics, and FRC Colors endpoints.
- Record counts, included/excluded counts, data shape, HTTP diagnostics, and EPA-bearing Statbotics match counts where the raw provider payload exposes those fields.
- Authenticated operational controls for event refresh, individual TBA resource refresh, Statbotics refresh, analytics recalculation, team refresh/seed, and scheduler start/stop.
- Pending Durable Object tasks, due times, intervals, attempts, and webhook-triggered authoritative refetch times.
- The single shared Multiplexer connection and subscription counts.

The command center refreshes its compact system overview every fifteen seconds. Event and team directories use a server-side, paginated search over the complete registered-key lists rather than filtering only the overview sample. Selecting an entity opens its own command center, addressable with an `?event=<key>` or `?team=<key>` query parameter. The entity view groups canonical analytics, provider resources, scheduled work, and entity-specific actions. Authenticated operations can refresh all event resources, refresh an individual TBA resource, refresh Statbotics event matches, force canonical analytics recalculation, refresh or seed a team profile, and start, stop, or manually run global discovery. Mutations are dispatched through the Worker admin router; the browser never receives the Worker service token.

The home page deliberately reports sampled coverage separately from registered inventory totals. Its missing-resource and missing-analytics counts describe only the event/team objects returned in the current overview sample (up to 250 of each type). They are not full-inventory coverage totals. A complete, resumable coverage audit that scans all registered objects is a separate planned operation; do not extrapolate sample counts to the full inventory.

## Inventory semantics and limits

The runtime maintains a lightweight registry of event and team keys observed by FieldView. Current-year event discovery registers event keys, and public/internal team and event routes register requested objects. The dashboard queries the corresponding Durable Object state; it does not enumerate Cloudflare's account-wide Durable Object platform inventory, and it cannot display objects never registered through FieldView. The overview currently returns at most 250 event and 250 team objects per refresh and indicates when that cap is exceeded.

A registered object may be reachable while having no acquired provider resources yet. That is distinct from an unavailable or failed provider resource.
