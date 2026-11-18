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
- Resource status, revision, last successful fetch, HTTP status, and recorded errors.
- Pending Durable Object tasks, due times, intervals, attempts, and webhook-triggered authoritative refetch times.
- The single shared Multiplexer connection and subscription counts.

The dashboard refreshes every ten seconds. It is read-only; it does not start/stop the scheduler, trigger provider requests, or mutate Durable Object state.

## Inventory semantics and limits

The runtime maintains a lightweight registry of event and team keys observed by FieldView. Current-year event discovery registers event keys, and public/internal team and event routes register requested objects. The dashboard queries the corresponding Durable Object state; it does not enumerate Cloudflare's account-wide Durable Object platform inventory, and it cannot display objects never registered through FieldView. The overview currently returns at most 250 event and 250 team objects per refresh and indicates when that cap is exceeded.

A registered object may be reachable while having no acquired provider resources yet. That is distinct from an unavailable or failed provider resource.
