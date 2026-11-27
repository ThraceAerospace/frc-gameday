# FieldView administrator authentication

The administrator dashboard is a standalone React SPA built into Workers Static Assets and served by the `runtime` Worker. The Vercel administrator page and API proxy are not part of the target architecture. Cloudflare Access and Worker-side verification protect the administrative surface.

## Request and authorization flow

1. Cloudflare Access protects `/admin*` and `/internal/admin/*` on the `runtime` Worker.
2. Access authenticates the administrator and injects `Cf-Access-Jwt-Assertion`.
3. The Worker verifies the Access JWT and checks the configured administrator email allowlist before serving the dashboard or executing an admin API operation.
4. The dashboard calls the same Worker's `/internal/admin/proxy`; the Worker routes the request to the appropriate internal admin operation.
5. `RUNTIME_ADMIN_TOKEN` is reserved for private Worker, Durable Object, and Workflow service-to-service calls. It is not a browser login credential.

## Worker-side verification

The Worker validates the RS256 signature against Cloudflare Access JWKS and checks the configured issuer, audience, expiry, not-before, issued-at timestamps, and exact case-insensitive administrator email allowlist. It does not trust unsigned identity headers or browser bearer tokens.

## Static hosting

The SPA is built from the dashboard components under `apps/web/src/app/admin/runtime`. Run `npm run build:admin` (or `node apps/admin-cloudflare/build.mjs`) to compile and bundle the app into `workers/fieldview/admin-assets`. Wrangler serves it through the static-assets binding. The `/admin` document request is worker-first and authorized before its HTML is returned. JavaScript/CSS under `/assets/*` is public application code and contains no secrets.

Keep worker-first routing for `/admin`, `/admin/*`, and `/internal/admin/*`. Do not apply Access to the entire Worker hostname: public runtime APIs, webhooks, and WebSocket upgrades have separate access contracts.

## Required configuration

Configure the Cloudflare Access application for the production Worker hostname and protect only:
- `/admin*`
- `/internal/admin/*`

Create an Allow policy for the approved administrator email addresses. The Worker requires:
- `CF_ACCESS_TEAM_DOMAIN` — the Cloudflare Access team issuer hostname.
- `CF_ACCESS_AUD` — the Access application's audience tag.
- `RUNTIME_ADMIN_EMAILS` — comma-separated exact email allowlist.

Configure the values separately for Production and any protected Preview environment. Do not expose production Workflows or credentials to an untrusted Preview.

## Worker secrets

The runtime requires server-side secrets such as:
- `TBA_API_KEY` — TBA API credential.
- `TBA_WEBHOOK_SECRET` — shared secret for incoming TBA webhook verification.
- `RUNTIME_ADMIN_TOKEN` — long random service credential for internal Worker/DO/Workflow authorization.

Configure secrets through Cloudflare's secret management or the ignored local `workers/fieldview/.dev.vars`. Never place values in source control, command-line arguments, frontend environment variables, or browser bundles. Preview secrets must be distinct from Production secrets.

## Validation and cutover

- Build the SPA with `npm run build:admin`.
- Validate D1 schema and Worker/Static Assets packaging with the repository CI and Wrangler dry-run.
- Verify unauthenticated `/admin` and `/internal/admin/*` requests are denied.
- Verify an allowed Access identity can load the dashboard and perform authorized operations.
- Verify public runtime APIs, webhook ingress, and WebSocket upgrades remain reachable under their own contracts.
- Verify Production and Preview secrets/bindings are distinct.
- Do not apply remote D1 migrations, deploy the Worker, or change production Access/secrets until separately approved as part of cutover.
