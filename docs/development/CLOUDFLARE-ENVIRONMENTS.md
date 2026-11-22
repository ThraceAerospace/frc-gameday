# Cloudflare environments

## Accepted target

FieldView uses exactly one Cloudflare Worker per environment:

| Environment | Worker name | Purpose |
|---|---|---|
| Preproduction | `fieldview-preprod` | Full integration and release validation |
| Production | `fieldview-production` | Live FieldView backend |

Each Worker hosts the HTTP API, webhook ingress, EventRuntime, TeamRuntime, Multiplexer, DiscoveryStore, and all three durable Workflows. Runtime and Jobs remain separate code modules, not separate deployed Workers. See [ADR-0017](../architecture/ADR-0017-single-worker-per-environment.md).

The environments must have independent Durable Object namespaces, Workflow bindings and instances, secrets, variables, and data. Preproduction must never share Production credentials or state.

Preproduction's current source requires the `TBA_API_KEY` and `TBA_WEBHOOK_SECRET` secrets. It also still uses the prototype `RUNTIME_ADMIN_TOKEN` for administrative operations; keep that token preproduction-only. The Production configuration must not be deployed with that prototype authorization design.

## Current repository state

The production/testing Wrangler files under `workers/fieldview-runtime` and `workers/fieldview-jobs` remain the experimental split-Worker configurations and are not the target topology. Their source modules are currently reused by the consolidated Worker; they are code modules, not separate deployable services. The consolidated entrypoint and target configurations live under `workers/fieldview`: `src/index.ts`, `wrangler.preprod.toml`, and `wrangler.production.toml`. The entrypoint composes Runtime and Jobs as modules, exports all four Durable Object classes and all three Workflows, and uses an in-process Jobs callback rather than a service binding. Workflow code accesses DiscoveryStore, EventRuntime, and TeamRuntime through their local namespaces; DiscoveryStore owns system-wide TBA discovery acquisition and publication. The consolidated source path passes the repository typecheck and test suite in GitHub Actions. Local Worker execution and Wrangler configuration validation remain pending. Do not deploy it or the experimental split configurations until those checks pass.

The existing test Worker deployments have no production data and are disposable. Nevertheless, leave them untouched until the consolidated implementation and configuration pass repository validation.

## Deployment controls

- Do not deploy automatically from CI.
- The user runs Wrangler commands manually and performs all Cloudflare deployments.
- Do not modify Cloudflare resources, secrets, routes, or Vercel project settings from ChatGPT.
- Do not cut over Production until Preproduction has passed smoke tests and the production administrator authorization design has replaced the prototype `RUNTIME_ADMIN_TOKEN` bearer token.
- Keep secrets out of source control and chat output.
