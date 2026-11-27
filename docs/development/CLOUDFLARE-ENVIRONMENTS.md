# Cloudflare Worker deployment and Previews

## Deployment topology

FieldView deploys one environment-neutral Cloudflare Worker named `runtime`. Do not create separate Worker identities for preview, testing, preproduction, staging, or production.

| Use | Worker | Configuration |
|---|---|---|
| Production | `runtime` | Top-level settings in `workers/fieldview/wrangler.toml` |
| Branch / pull-request validation | Same `runtime` identity | Cloudflare Workers Preview URLs and the `[previews]` configuration in the same file |
| Local development | Wrangler local runtime | `workers/fieldview/.dev.vars` |

Wrangler named environments are not used. Production deployment is a deliberate operator action, not an automatic CI side effect.

## Resource configuration

The single Wrangler file declares the Worker entrypoint, static admin assets, Cron triggers, D1 and KV bindings, Durable Object classes, Workflow bindings, and Preview bindings.

The current runtime Durable Object classes are EventRuntime, TeamRuntime, Multiplexer, and RemoteSessionRuntime. EventRuntime and TeamRuntime own canonical provider endpoint records and scope-local state. Multiplexer owns the public realtime stream. RemoteSessionRuntime owns remote display signaling.

D1 owns discovery and operational/system records through typed repositories. KV is limited to lightweight, non-authoritative projections and canonical pointers. Durable Object SQLite is the canonical store for runtime-owned provider endpoint data. There is no R2 binding, Redis service, or Cloudflare Queue refresh path.

## Preview isolation and limitations

- Preview variables and resource bindings are declared explicitly; do not assume they inherit production configuration.
- Preview Durable Object namespaces/storage are isolated by Cloudflare for each Preview.
- Preview D1 and KV bindings must point to non-production resources.
- Cloudflare Workers Previews do not provide isolated Workflow instances through the current configuration. Do not bind Preview traffic to production Workflows. Workflow-dependent operations must be tested locally or through an explicitly provisioned non-production Workflow environment before relying on them for integration sign-off.
- Preview URLs may be publicly reachable. Apply the appropriate access controls before sharing administrative functionality.
- Production secrets are configured in Cloudflare and are never committed to source control.

## Local configuration

The Worker reads local variables and secrets from one ignored file:

```sh
cp workers/fieldview/.dev.vars.example workers/fieldview/.dev.vars
npm run dev:worker
```

Frontend environment variables remain in the Vercel project configuration. Do not source frontend environment files into the Worker or duplicate server secrets into browser-visible variables.

## Operator commands

Use the Wrangler version and scripts pinned by the repository. The canonical config path is always `workers/fieldview/wrangler.toml`.

```sh
# Local Worker
npm run dev:worker

# Preview for the current branch
npx wrangler preview --config workers/fieldview/wrangler.toml

# Production deployment — explicit operator action only
npx wrangler deploy --config workers/fieldview/wrangler.toml
```

Do not add `--env` or a second Wrangler configuration. Verify the selected account, resource bindings, secrets, migrations, and target before any deployment command.

## Cutover safeguards

- Do not deploy automatically from CI.
- Do not point Preview D1/KV bindings at production resources.
- Do not bind Preview requests to production Workflows.
- Do not apply D1 migrations or mutate remote resources without explicit cutover authorization.
- Do not deploy production until the integration gate and production administrator authorization requirements are satisfied.

See [the production integration and cutover plan](../architecture/MIGRATION-PLAN.md) for the release gate.
