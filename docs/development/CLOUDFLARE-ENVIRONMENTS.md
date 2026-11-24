# Cloudflare Worker deployment and Previews

## Accepted deployment topology

FieldView uses **one Cloudflare Worker** named `runtime`. The name is environment-neutral; do not create separate Worker names for preview, preproduction, staging, or production.

| Deployment | Worker identity | Configuration |
|---|---|---|
| Production | `runtime` | Top-level settings in `workers/fieldview/wrangler.toml` |
| Branch / pull-request Preview | Same `runtime` Worker | The `[previews]` settings in the same Wrangler file |

Production's stable `workers.dev` URL is `runtime.frc-fieldview.workers.dev`. Preview URLs are enabled in Wrangler and use Cloudflare's branch-preview hostname format: `<preview-name>-runtime.frc-fieldview.workers.dev`. The preview name defaults to the current Git branch; pass `--name` to choose a stable alias such as `testing`. A custom preview domain is a separate Cloudflare domain configuration and must be configured on this same Worker, not by creating another Worker.

Cloudflare Workers Previews automatically provide a separate Durable Object namespace and storage for each Preview. The four Durable Object classes and their migration history remain declared at the top level; the same `env` bindings are repeated under `[previews.durable_objects]` so Preview code receives its isolated namespaces.

## Preview limitations and isolation

- Preview variables are declared under `[previews.vars]`; they do not inherit production variables. Keep preview values explicit and safe.
- Preview secrets are configured through Cloudflare's Preview Base settings (or per-Preview secret commands), never committed to Wrangler configuration or source control.
- **Do not bind Preview requests to production Workflows.** Cloudflare Preview Workflow bindings target existing Workflow resources and use those Workflows' deployed code, bindings, and instances; they are not automatically isolated per Preview. The current configuration therefore does not expose Workflow bindings to Previews. Workflow-dependent admin operations are not available in branch Previews until a dedicated non-production Workflow strategy is implemented.
- Production Workflow bindings remain at the top level.
- Preview URLs are public unless Cloudflare Access is configured. Protect them before sharing private or administrative functionality.
- The existing prototype `RUNTIME_ADMIN_TOKEN` is not a production authorization design and must not be deployed as a Production secret.

## Commands

From the repository root:

```bash
# Local development; no Wrangler named environment
npm run dev:worker

# Create or update a Preview for the current Git branch
npx --yes wrangler@^4.135.0 preview

# Deploy the production Worker (manual operator action only)
npx --yes wrangler@^4.135.0 deploy --config workers/fieldview/wrangler.toml
```

Workers Previews require Wrangler 4.135.0 or later. Use the repository's configured Wrangler file for both production and Preview operations. Do not use `--env`; Wrangler named environments create separate Worker identities and are not part of this architecture.

## Local secrets

Use exactly one local environment file: `.env` at the repository root. It is ignored by Git and shared by the Next.js workspace and the consolidated local Worker.

- Next.js loads the root file through `@next/env` in `apps/web/next.config.ts`.
- The local Worker process loads the same root file through the `dev:worker` script.
- Do not create workspace-specific `.env.local`, `.dev.vars`, or other duplicate secret files.
- Keep the root file local. Cloudflare Production and Preview secrets are configured separately in Cloudflare and are not synchronized from this local file.

## Current repository state

The `workers/fieldview-runtime` and `workers/fieldview-jobs` directories are source modules, not independently deployed Workers. Their code is composed by `workers/fieldview/src/index.ts`, the single deployment entrypoint. Jobs dispatch uses an in-process callback; no Runtime-to-Jobs, Jobs-to-Runtime, or self-service Worker service bindings are used.

The single Wrangler configuration declares the four Durable Object classes (EventRuntime, TeamRuntime, Multiplexer, and transitional DiscoveryStore) and the four production Workflows (DailyEventReadinessWorkflow, DailyTeamReadinessWorkflow, CoverageAuditWorkflow, and RuntimeAdminWorkflow). Durable Object classes and migrations are shared in configuration but Cloudflare provisions isolated namespace/storage for each Preview. Preview Workflow bindings are intentionally omitted for the isolation reason above.

The current DiscoveryStore Durable Object remains transitional until Discovery and System Records D1 repositories are implemented and cut over. Do not remove its binding until every key/caller has been classified, D1 repositories and migrations are implemented, cutover/rollback is verified, and old operational responsibilities are removed. Production and Preview data must never be shared accidentally.

## Deployment controls

- Do not deploy automatically from CI.
- The user runs Wrangler commands manually and performs all Cloudflare deployments.
- Do not modify Cloudflare resources, secrets, routes, or Vercel project settings from ChatGPT.
- Do not cut over Production until Previews/local validation and the production administrator authorization design have replaced the prototype `RUNTIME_ADMIN_TOKEN` bearer token.
- Keep secrets out of source control and chat output.

## Storage-domain migration

The accepted 2026-11-24 decision defines three storage domains:

- Discovery: D1 is authoritative for event/team directories, current-season metadata, and discovery refresh records. KV may serve lightweight read-heavy projections such as `events-this-week`.
- System Records: D1 stores Workflow execution/progress/outcomes, runtime registration, administrative actions, and operational history in a schema/repository separate from Discovery.
- Runtime State: EventRuntime and TeamRuntime Durable Objects retain canonical entity state, provider validators, and reconciliation state; Multiplexer retains subscription coordination.

The current Wrangler configuration still binds the transitional DiscoveryStore Durable Object because its records and callers have not yet been migrated. Previews isolate this Durable Object's namespace automatically. Do not remove that binding until the D1 migration and cutover are complete.
