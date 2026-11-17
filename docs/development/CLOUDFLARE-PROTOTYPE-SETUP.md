# FieldView Cloudflare Prototype Setup

This runbook creates an isolated Cloudflare Worker prototype for the architecture migration. It is not a production deployment plan.

## Isolation guarantees

- Worker name: `fieldview-runtime-prototype`.
- Account `workers.dev` subdomain: `frc-fieldview.workers.dev`.
- Deployment target: `https://fieldview-runtime-prototype.frc-fieldview.workers.dev` only.
- No custom domain, production route, Vercel routing change, or production secret is configured.
- The prototype has its own Durable Object namespaces and migration history. Do not add `script_name` values pointing at another Worker.
- The existing `workers/fieldview-runtime/wrangler.toml` remains the separate non-prototype configuration.
- No Cron Trigger is configured. The global event scheduler is started explicitly after deployment.
- The prototype uses the same source code and SQLite-backed Durable Object classes, but its stored state is independent.

## Prerequisites

1. A Cloudflare account with Workers enabled and a `workers.dev` subdomain activated.
2. Node.js/npm and the repository checked out on `fieldview-architecture-migration`.
3. A The Blue Alliance API key.
4. Permission to create/deploy Workers and Durable Objects in the intended Cloudflare account.

Cloudflare's Workers Free plan supports SQLite-backed Durable Objects; check the current account limits and pricing before sustained live-event use.

## Local validation

From the repository root:

```sh
npx wrangler --version
npx wrangler whoami
npx wrangler dev --config workers/fieldview-runtime/wrangler.prototype.toml
```

Local Wrangler development uses local Durable Object state. Do not place real production credentials in a committed file. For local webhook testing, use a dedicated test TBA webhook secret and a non-production TBA key where possible.

## First remote prototype deployment

Do these steps only when the user has explicitly approved a remote prototype deployment.

1. Authenticate Wrangler against the intended Cloudflare account and verify the account identity:

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

2. Review the exact target configuration before publishing:

   ```sh
   npx wrangler deploy --config workers/fieldview-runtime/wrangler.prototype.toml --dry-run
   ```

3. Add secrets to the prototype Worker only. Never use `vars`, commit a `.dev.vars` file, or paste secret values into chat:

   ```sh
   npx wrangler secret put TBA_API_KEY --config workers/fieldview-runtime/wrangler.prototype.toml
   npx wrangler secret put TBA_WEBHOOK_SECRET --config workers/fieldview-runtime/wrangler.prototype.toml
   npx wrangler secret put RUNTIME_ADMIN_TOKEN --config workers/fieldview-runtime/wrangler.prototype.toml
   ```

   Generate `RUNTIME_ADMIN_TOKEN` as a high-entropy random secret and retain it in the operator's password manager. Use a dedicated webhook secret for this prototype.

4. Deploy only the prototype config:

   ```sh
   npx wrangler deploy --config workers/fieldview-runtime/wrangler.prototype.toml
   ```

5. Record the returned `workers.dev` URL. Verify:

   ```sh
   curl -fsS https://fieldview-runtime-prototype.frc-fieldview.workers.dev/health
   ```

   Expected response: `{"service":"fieldview-runtime","status":"ok"}`.

6. Configure a TBA webhook using:
   - URL: `https://<prototype-worker>.<account-subdomain>.workers.dev/webhooks/tba`
   - Secret: the exact value stored as prototype `TBA_WEBHOOK_SECRET`.
   - Event scope: start with a deliberately selected test event, not all events.

   Verify the TBA webhook's ping/verification handshake before enabling event notifications. Do not expose the admin token to TBA or browsers.

7. Start global event discovery using the prototype admin token:

   ```sh
   curl -fsS -X POST \
     -H "Authorization: Bearer $RUNTIME_ADMIN_TOKEN" \
     https://<prototype-worker>.<account-subdomain>.workers.dev/internal/scheduler/start
   ```

   Check scheduler state:

   ```sh
   curl -fsS \
     -H "Authorization: Bearer $RUNTIME_ADMIN_TOKEN" \
     https://<prototype-worker>.<account-subdomain>.workers.dev/internal/scheduler/state
   ```

   The scheduler discovers only the current calendar year's events and then repeats at the configured one-hour interval. It is intentionally not auto-started by a Cron Trigger.

8. Validate a populated discovery year:

   ```sh
   curl -i "https://<prototype-worker>.<account-subdomain>.workers.dev/events/discovery?year=<year>"
   ```

9. Set the web app's preview-only server and browser runtime origins to the prototype URL only after the runtime health, discovery, snapshot, and stream checks pass:
   - Server-only: `FIELDVIEW_RUNTIME_URL`
   - Browser build-time: `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL`

   Do not set these in production Vercel environments. Do not enable the canonical transport in the production deployment.

## Required prototype acceptance checks

- Health endpoint responds.
- Scheduler starts, persists state, discovers event years, and survives a Worker restart.
- TBA webhook signature verification rejects invalid signatures and accepts valid ping/verification messages.
- A real test-event webhook is retained and follows the existing event-specific refresh behavior.
- The authoritative TBA REST refetch retains its configured 65-second settling delay; it is not replaced with an immediate request.
- Statbotics remains TBA-change-driven only, with its separate configured settling delay and bounded retries; there is no independent Statbotics poll.
- Canonical event snapshot contains the expected normalized resources and source metadata.
- Shared multiplexer accepts browser WebSocket connections, deduplicates subscriptions, filters notifications, and recovers snapshots after reconnect.
- Upcoming/active/completed lifecycle polling follows the configured policy.
- A failed refresh does not erase the last good representation.
- No request reaches the legacy production data path except through the still-existing Vercel deployment.

## Stop / rollback

- Stop global discovery with authenticated `POST /internal/scheduler/stop`.
- Remove the prototype TBA webhook registration.
- Remove preview-only runtime URL variables from the preview app.
- Do not delete Durable Object namespaces as a casual rollback step; they contain prototype state.
- Do not change production routes, production secrets, or the existing Vercel runtime during prototype rollback.

## Operator values to collect

- Cloudflare account identity and `frc-fieldview.workers.dev` account subdomain.
- Confirmation that the account is authorized for the prototype.
- Prototype TBA API key and webhook secret (entered directly into Wrangler, never chat).
- Generated prototype runtime admin token (stored outside the repository).
- Selected TBA test event key.
- Preview deployment URL(s) for the web application.

The Cloudflare account identity, subdomain, secret values, TBA webhook registration, and first remote deployment are deliberate operator checkpoints. This repository preparation does not perform any of them.
