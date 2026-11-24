# Cloudflare environments

## Accepted target

FieldView uses exactly one Cloudflare Worker per environment:

| Environment | Worker name | Purpose |
|---|---|---|
| Preproduction | `fieldview-preprod` | Full integration and release validation |
| Production | `fieldview-production` | Live FieldView backend |

Each Worker hosts the HTTP API, webhook ingress, EventRuntime, TeamRuntime, Multiplexer, the currently transitional DiscoveryStore Durable Object, and all deployed Workflows. Runtime and Jobs remain separate code modules, not separate deployed Workers. The target storage model adds environment-specific D1 repositories for Discovery and System Records; those are separate schemas/ownership domains even if they initially share a D1 database. See [ADR-0017](../architecture/ADR-0017-single-worker-per-environment.md).

The environments must have independent Durable Object namespaces, Workflow bindings and instances, secrets, variables, and data. Preproduction must never share Production credentials or state.

Preproduction's current source requires the `TBA_API_KEY` and `TBA_WEBHOOK_SECRET` secrets. It also still uses the prototype `RUNTIME_ADMIN_TOKEN` for administrative operations; keep that token preproduction-only. The Production configuration must not be deployed with that prototype authorization design.

## One local environment file

Use exactly one local environment file: `.env` at the repository root. It is ignored by Git and is shared by the Next.js workspace and the consolidated local Worker.

- Next.js loads the root file through `@next/env` in `apps/web/next.config.ts`.
- Wrangler loads the same file explicitly with `--env-file .env`.
- Do not create `workers/fieldview/.dev.vars`, `workers/fieldview-runtime/.dev.vars`, workspace `.env.local` files, or other per-package secret files.
- Keep the root file local. Cloudflare Preproduction and Production credentials remain independently configured in their respective Cloudflare environments; the local file does not synchronize or deploy secrets.
- Put local-only values such as `RUNTIME_ADMIN_TOKEN` in the root file. The prototype token remains preproduction/local-only and must not become a Production secret.

From the repository root, start the consolidated Worker with:

```bash
npx wrangler dev --config workers/fieldview/wrangler.preprod.toml --env-file .env
```

## Current repository state

The production/testing Wrangler files under `workers/fieldview-runtime` and `workers/fieldview-jobs` remain the experimental split-Worker configurations and are not the target topology. Their source modules are currently reused by the consolidated Worker; they are code modules, not separate deployable services. The consolidated entrypoint and target configurations live under `workers/fieldview`: `src/index.ts`, `wrangler.preprod.toml`, and `wrangler.production.toml`. The entrypoint composes Runtime and Jobs as modules, exports all four Durable Object classes and all three Workflows, and uses an in-process Jobs callback rather than a service binding. Workflow code accesses DiscoveryStore, EventRuntime, and TeamRuntime through their local namespaces; DiscoveryStore owns system-wide TBA discovery acquisition and publication. The consolidated source path passes the repository typecheck and test suite in GitHub Actions. Both target Wrangler configurations pass `--dry-run`, and local Worker startup has been verified; end-to-end Workflow execution and data-readiness validation remain pending. Do not deploy it or the experimental split configurations until those checks pass.

The existing test Worker deployments have no production data and are disposable. Nevertheless, leave them untouched until the consolidated implementation and configuration pass repository validation.



## Storage-domain migration

The accepted 2026-11-24 decision defines three storage domains:

- Discovery: D1 is authoritative for event/team directories, current-season metadata, and discovery refresh records. KV may serve lightweight read-heavy projections such as `events-this-week`.
- System Records: D1 stores Workflow execution/progress/outcomes, runtime registration, administrative actions, and operational history in a schema/repository separate from Discovery.
- Runtime State: EventRuntime and TeamRuntime Durable Objects retain canonical entity state, provider validators, and reconciliation state; Multiplexer retains subscription coordination.

The current Wrangler configurations still bind the transitional DiscoveryStore Durable Object because its records and callers have not yet been migrated. Do not remove that binding until every key/caller has been classified, D1 repositories and migrations are implemented, cutover/rollback is verified, and the old operational responsibilities are removed. Preproduction and Production must have independent D1/KV resources and must never share data or credentials. No resource creation, binding change, or deployment is authorized by this documentation update.

## Deployment controls

- Do not deploy automatically from CI.
- The user runs Wrangler commands manually and performs all Cloudflare deployments.
- Do not modify Cloudflare resources, secrets, routes, or Vercel project settings from ChatGPT.
- Do not cut over Production until Preproduction has passed smoke tests and the production administrator authorization design has replaced the prototype `RUNTIME_ADMIN_TOKEN` bearer token.
- Keep secrets out of source control and chat output.
