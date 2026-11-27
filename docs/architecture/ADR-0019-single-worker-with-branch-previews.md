# ADR-0019: One Runtime Worker with branch Previews

- **Status:** Accepted
- **Date:** 2026-11-24
- **Supersedes:** [ADR-0017](ADR-0017-single-worker-per-environment.md)

## Context

Cloudflare Workers Previews provide branch- and pull-request-specific deployments under the same Worker identity, with separate Preview URLs and Durable Object namespaces. Separate Worker identities for preview, preproduction, staging, and production would duplicate configuration and are not part of the target.

## Decision

FieldView deploys exactly one environment-neutral Cloudflare Worker named `runtime`.

- The top-level `workers/fieldview/wrangler.toml` configuration is the Production Worker configuration.
- The same configuration declares `preview_urls = true` and explicit Preview bindings for branch and pull-request Previews.
- Production is available at `runtime.frc-fieldview.workers.dev`; Cloudflare generates branch-specific Preview hostnames.
- Do not use Wrangler named environments or create separate Worker identities for preview, preproduction, staging, or production.
- Runtime and Jobs remain separate source modules composed by the single Worker entrypoint.
- Durable Object classes and migrations are declared in the single configuration. Preview Durable Object namespaces/storage are isolated by Cloudflare.
- Production variables and Workflow bindings remain at the top level. Preview variables are explicit under `[previews.vars]`; secrets are configured separately and never committed.
- Do not bind branch Previews to Production Workflows. Preview Workflow instances are not automatically isolated by the current configuration; workflow-dependent Preview operations require a separately provisioned non-production strategy.
- Preview URLs are public unless protected with Cloudflare Access. Protect administrative Preview surfaces before sharing them.

## Local development and deployment

Local Worker development uses `workers/fieldview/.dev.vars`:

```sh
cp workers/fieldview/.dev.vars.example workers/fieldview/.dev.vars
npm run dev:worker
```

Preview and production commands use the same Wrangler configuration:

```sh
npx wrangler preview --config workers/fieldview/wrangler.toml
npx wrangler deploy --config workers/fieldview/wrangler.toml
```

Production deployment is an explicit operator action after the integration gate and authorization review. Do not add automatic production deployment to CI.

## Consequences

The architecture has one stable Worker identity and one source-controlled Wrangler configuration, with branch Preview URLs and isolated Preview Durable Object namespaces. Workflow isolation, Preview D1/KV separation, Access protection, and public Preview exposure remain explicit operational considerations.

This ADR defines deployment topology only. It does not authorize resource creation/deletion, secret changes, production deployment, or cutover.
