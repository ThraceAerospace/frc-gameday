# Cloudflare environments

## Accepted target

FieldView uses exactly one Cloudflare Worker per environment:

| Environment | Worker name | Purpose |
|---|---|---|
| Preproduction | `fieldview-preprod` | Full integration and release validation |
| Production | `fieldview-production` | Live FieldView backend |

Each Worker hosts the HTTP API, webhook ingress, EventRuntime, TeamRuntime, Multiplexer, DiscoveryStore, and all three durable Workflows. Runtime and Jobs remain separate code modules, not separate deployed Workers. See [ADR-0017](../architecture/ADR-0017-single-worker-per-environment.md).

The environments must have independent Durable Object namespaces, Workflow bindings and instances, secrets, variables, and data. Preproduction must never share Production credentials or state.

## Current repository state

The existing `workers/fieldview-runtime` and `workers/fieldview-jobs` directories and their production/testing Wrangler files are the experimental split-Worker prototype. They are not yet consolidated into the accepted target. Do not deploy those configurations as a final environment topology. The source and Wrangler refactor must be completed and validated before experimental Cloudflare resources are removed or replacement resources are created.

The existing test Worker deployments have no production data and are disposable. Nevertheless, leave them untouched until the consolidated implementation and configuration pass repository validation.

## Deployment controls

- Do not deploy automatically from CI.
- The user runs Wrangler commands manually and performs all Cloudflare deployments.
- Do not modify Cloudflare resources, secrets, routes, or Vercel project settings from ChatGPT.
- Do not cut over Production until Preproduction has passed smoke tests and the production administrator authorization design has replaced the prototype `RUNTIME_ADMIN_TOKEN` bearer token.
- Keep secrets out of source control and chat output.
