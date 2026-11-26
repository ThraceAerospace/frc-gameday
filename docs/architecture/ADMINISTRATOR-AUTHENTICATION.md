# FieldView administrator authentication

**Status:** The existing React administrator dashboard is built as a standalone SPA in Workers Static Assets and served by the existing `runtime` Worker. The Vercel administrator page and API proxy are removed. Cloudflare Access policies and Worker environment values remain provisioning steps.

## Request and authorization flow

1. Cloudflare Access protects `/admin*` and `/internal/admin/*` on `runtime.frc-fieldview.workers.dev`.
2. Access authenticates the administrator and injects `Cf-Access-Jwt-Assertion`.
3. The Runtime Worker independently verifies the JWT and checks the exact administrator email allowlist before serving the dashboard or any admin API operation.
4. The dashboard calls the same Worker's `/internal/admin/proxy`; this maps its existing request contract to internal admin routes without involving Vercel.
5. `RUNTIME_ADMIN_TOKEN` remains exclusively for private Worker, Durable Object, and Workflow calls.

## Worker-side verification

The Worker validates the RS256 signature against the team's published JWKS and checks the exact issuer, audience, expiry, not-before, issued-at timestamps, and exact case-insensitive email allowlist. It does not trust unsigned identity headers or browser bearer tokens.

## Static hosting

The SPA is built from the existing React dashboard components in `apps/web/src/app/admin/runtime`. Run `npm run build:admin` (or `node apps/admin-cloudflare/build.mjs`) to compile Tailwind and bundle the app into `workers/fieldview/admin-assets`. Wrangler serves the output through the static-assets binding. The `/admin` document request is worker-first and authorized before its HTML is returned. JavaScript/CSS under `/assets/*` is public application code and contains no secrets.

Keep worker-first routing for `/admin`, `/admin/*`, and `/internal/admin/*`. Do not apply Access to the entire Worker hostname: public runtime APIs and WebSocket upgrades must remain reachable.

## Required Cloudflare configuration

Create a Self-hosted Access application for `runtime.frc-fieldview.workers.dev` with path coverage `/admin*` and `/internal/admin/*`. Use an Allow policy restricted to exact administrator email addresses. Configure Production and Preview Worker variables as appropriate: `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `RUNTIME_ADMIN_EMAILS`.

Keep `RUNTIME_ADMIN_TOKEN` as an internal Worker secret only. No token belongs in Vercel or browser code.

## Validation and rollout

- Build the SPA with `node apps/admin-cloudflare/build.mjs`.
- Run Worker typecheck and the full workspace test suite.
- Verify unauthenticated `/admin` and `/internal/admin/*` requests are denied.
- Verify an allowed Access identity can load the dashboard and perform read/write operations.
- Verify public runtime routes and WebSocket upgrades are unaffected.
- Confirm the Vercel deployment no longer contains the admin page or API proxy.
- Deploy only after explicit production rollout approval.
