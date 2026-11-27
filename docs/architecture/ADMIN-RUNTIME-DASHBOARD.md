# Runtime admin dashboard

The runtime administration SPA is built from the reusable React dashboard components and served by the Cloudflare Worker Static Assets binding at `/admin/runtime`. The Worker authorizes the admin document and private API routes through Cloudflare Access. The browser calls the Worker's same-origin `/internal/admin/proxy`; it never receives the internal Worker service credential.

See [Administrator authentication](ADMINISTRATOR-AUTHENTICATION.md) for the authorization boundary and [Cloudflare deployment](../development/CLOUDFLARE-ENVIRONMENTS.md) for resource configuration.

## Monitored state

The dashboard presents operational information from the Worker, D1 System Records, and registered runtime identities, including:

- Registered EventRuntime and TeamRuntime identities.
- Provider endpoint status, revision, last successful fetch, last attempt, expiry, HTTP status, webhook time when present, and recorded errors.
- Workflow execution records and polling-coordinator status.
- EventRuntime and TeamRuntime provider-resource diagnostics.
- Analytics publication status, source revisions, coverage, and recorded failures.
- Multiplexer connection and subscription counts.
- Discovery coverage and resumable operational audits where implemented.

A registered runtime identity may exist before its initial provider endpoint resources have been acquired. Registration, bootstrap progress, endpoint availability, and snapshot projection are distinct states.

## Operations

Authenticated administrative operations are dispatched through the Worker admin router. Depending on the operation, the dashboard can initiate event/team initialization or refresh, refresh individual provider resources, request analytics recalculation, seed an entity, or refresh discovery.

First-time runtime initialization may invoke the one-time provider bootstrap described by ADR-0020. This operation hydrates the runtime's provider endpoint records; it does not materialize EventState or TeamState. Subsequent provider refreshes are executed by the owning runtime after an explicit command. The polling coordinator owns recurring cadence and bounded dispatch; there are no per-runtime alarm deadlines or local task queues.

The dashboard's overview and entity panels are operational views, not canonical data owners. Public snapshot reads remain read-only and derive EventState/TeamState from provider endpoint records.

## Inventory semantics

FieldView maintains a D1 System Records registry of runtime identities. The dashboard inspects identities known to that registry and the corresponding Durable Object state; it does not enumerate Cloudflare's account-wide Durable Object inventory. An unregistered runtime is not activated merely to inspect it.

Sampled overview counts and full-season coverage scans have different scopes. Any coverage result must state whether it represents the complete selected-season discovery directory or only the sampled registered entities.

## Security

- Cloudflare Access protects `/admin*` and `/internal/admin/*`.
- The Worker verifies the Access JWT and checks the configured administrator allowlist.
- `RUNTIME_ADMIN_TOKEN` is a server-side service credential only; it is never rendered or sent to the browser.
- Do not place Worker credentials in frontend environment variables or browser bundles.
