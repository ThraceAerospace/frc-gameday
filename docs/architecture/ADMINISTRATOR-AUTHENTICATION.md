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

### Access application

Access is not currently enabled on the connected Cloudflare account. Before creating the application, enable Cloudflare Zero Trust / Access in the dashboard and select the account's Zero Trust team domain.

Create a **Self-hosted** Access application for `runtime.frc-fieldview.workers.dev`. Protect only these paths:

- `/admin*`
- `/internal/admin/*`

Create an Allow policy with an **Emails** include rule for the administrator addresses. The current primary administrator is `boyspockie@gmail.com`; additional addresses may be added later. Do not protect the whole hostname, since public runtime APIs and WebSocket routes must remain unauthenticated.

Record the Access application's **Application Audience (AUD) Tag** and the Zero Trust team domain. The Worker requires:

- `CF_ACCESS_TEAM_DOMAIN` — the team issuer hostname, e.g. `<team>.cloudflareaccess.com`.
- `CF_ACCESS_AUD` — the Access application's audience tag.
- `RUNTIME_ADMIN_EMAILS` — comma-separated exact email allowlist, initially `boyspockie@gmail.com`.

Configure the three values in both Production and Preview Worker settings. Preview Access protection must be configured for the Preview hostname/path behavior separately if Preview admin testing is desired; do not allow Preview to use production Workflow bindings.

### Worker secrets

The application also requires these secrets before the first functional deployment:

- `TBA_API_KEY` — FIRST The Blue Alliance API key.
- `TBA_WEBHOOK_SECRET` — shared secret used to verify incoming TBA webhooks.
- `RUNTIME_ADMIN_TOKEN` — long random service credential used only for internal Worker/DO/Workflow authorization. It is not the administrator's login credential.

Set secrets interactively from the repository root, without placing their values in source control or command-line arguments:

```sh
npx wrangler@^4.135.0 secret put TBA_API_KEY --config workers/fieldview/wrangler.toml
npx wrangler@^4.135.0 secret put TBA_WEBHOOK_SECRET --config workers/fieldview/wrangler.toml
npx wrangler@^4.135.0 secret put RUNTIME_ADMIN_TOKEN --config workers/fieldview/wrangler.toml
```

Repeat secret configuration for the Preview environment using Wrangler's documented Preview secret workflow. Never reuse a production internal token in untrusted Preview environments. Local development values belong in the ignored `workers/fieldview/.dev.vars` file; never commit it.

### Storage and runtime resources

The single Wrangler configuration declares the production and Preview D1/KV bindings, SQLite-backed Durable Object classes, and Workflow bindings. The initial D1 schema is in `workers/fieldview/migrations/0001_initial.sql`. Applying it remotely is a separate state-changing operation and requires explicit approval. Cloudflare must provision the declared Worker/DO/Workflow resources during deployment; verify the deployed bindings against `wrangler.toml` before enabling scheduled work or webhook delivery.

## Validation and rollout

- Build the SPA with `npm run build:admin`.
- Run Worker typecheck and the full workspace test suite.
- Verify unauthenticated `/admin` and `/internal/admin/*` requests are denied.
- Verify an allowed Access identity can load the dashboard and perform read/write operations.
- Verify public runtime routes and WebSocket upgrades are unaffected.
- Verify production and Preview secrets/bindings are distinct.
- Confirm the Vercel deployment no longer contains the admin page or API proxy.
- Do not apply remote D1 migrations, deploy the Worker, change production secrets/configuration, or cut over traffic until separately approved.
