# ADR-0019: One Runtime Worker with branch Previews

- **Status:** Accepted
- **Date:** 2026-11-24
- **Supersedes:** [ADR-0017](ADR-0017-single-worker-per-environment.md)

## Context

The previous deployment model used Wrangler named environments to create separate Worker identities (`runtime-preprod` and `runtime-production`). Cloudflare Workers Previews now provide branch- and pull-request-specific deployments under the same Worker, with separate Preview URLs, configuration, and Durable Object namespaces. Maintaining separate Worker identities for each deployment environment is unnecessary and adds avoidable configuration and resource duplication.

## Decision

FieldView deploys exactly one environment-neutral Cloudflare Worker named `runtime`.

- The top-level `workers/fieldview/wrangler.toml` configuration is the Production Worker configuration.
- The same configuration contains a `[previews]` block for branch and pull-request Previews.
- `preview_urls = true` enables the Worker's Preview URL host. The account's `frc-fieldview.workers.dev` subdomain is used for workers.dev Preview URLs; Cloudflare generates branch-specific hostnames in the form `<preview-name>-runtime.frc-fieldview.workers.dev`.
- Production remains available at `runtime.frc-fieldview.workers.dev`.
- Do not use Wrangler named environments or create separate Worker identities for preview, preproduction, staging, or production.
- Keep Runtime and Jobs as separate source modules composed by the single Worker entrypoint. A single Worker does not mean a single Durable Object.
- Durable Object classes and migration history are declared at the top level. Because the code accesses Durable Object namespaces through `env` bindings, repeat those binding declarations in `[previews.durable_objects]`; Cloudflare provisions separate namespaces and storage for each Preview.
- Production variables and Workflow bindings remain at the top level. Preview variables are explicit under `[previews.vars]`; secrets are configured through Cloudflare Preview Base or per-Preview secret management and are never committed.
- Do not bind branch Previews to Production Workflows. Cloudflare Preview Workflow bindings target an existing Workflow's deployed code and instances; they are not automatically isolated per Preview. Until a dedicated non-production Workflow strategy is implemented, Workflow-dependent admin operations are intentionally unavailable in branch Previews. Production Workflow bindings remain configured at the top level.
- Preview URLs are public by default. Configure Cloudflare Access before exposing private or administrative Preview surfaces.

## Deployment workflow

- Local development: `npm run dev:worker`, using the root `.env` file and no Wrangler named environment.
- Branch / pull-request Preview: `npx --yes wrangler@^4.135.0 preview`. The current Git branch is used as the Preview name by default; `--name` may select an alias.
- Production deployment: `npx --yes wrangler@^4.135.0 deploy --config workers/fieldview/wrangler.toml`, performed manually by the operator only after required validation and authorization review.

Wrangler 4.135.0 or later is required for Workers Previews. Keep the Worker configuration as the source of truth; do not rely on dashboard-only changes that would be overwritten by a later Wrangler deployment.

## Consequences

Benefits:
- One stable Worker identity and production URL.
- Branch-specific Preview deployments and URLs without additional Worker identities.
- Automatic per-Preview Durable Object namespace and storage isolation.
- One source-controlled Wrangler configuration for Production and Preview settings.

Tradeoffs and limitations:
- Production and Preview deployments share the Worker's deployment identity and configuration history.
- Workflow resources are not automatically isolated per Preview; preview Workflow behavior remains unavailable until a dedicated safe strategy is implemented.
- Preview URLs are public unless protected with Cloudflare Access.
- Custom Preview domains, if required, must be configured on the same Worker using Cloudflare's Preview custom-domain configuration; they do not justify another Worker.

## Safety constraints

This decision changes repository architecture and configuration only. It does not authorize deployment, Worker renaming, resource creation/deletion, secret changes, route changes, Vercel changes, or Production cutover. Existing Cloudflare resources remain untouched until the operator separately reviews and executes a migration plan.
