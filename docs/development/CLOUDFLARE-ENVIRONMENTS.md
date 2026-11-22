# FieldView Cloudflare Environments

FieldView has two persistent Cloudflare environments. The Git branch determines which Wrangler configuration is deployed; the application does not infer its environment from the branch.

| Git branch | Runtime Worker | Runtime URL | Jobs Worker | Wrangler configuration |
| --- | --- | --- | --- | --- |
| `main` | `runtime` | `https://runtime.frc-fieldview.workers.dev` | `fieldview-jobs` | `wrangler.toml` |
| Any non-main branch | `testing` | `https://testing.frc-fieldview.workers.dev` | `fieldview-jobs-testing` | `wrangler.testing.toml` |

The testing environment is a **shared, persistent test target**. Deploying a different non-main branch replaces the code at the same testing URL; it does not create a separate URL or isolated environment for every branch. Wrangler's automatic Preview URLs are disabled so the fixed testing hostname remains the intended endpoint.

## Resource separation

| Resource | Production | Testing |
| --- | --- | --- |
| Runtime Worker | `runtime` | `testing` |
| Jobs Worker | `fieldview-jobs` | `fieldview-jobs-testing` |
| R2 discovery bucket | `fieldview-discovery` | `fieldview-discovery-testing` |
| Runtime Durable Objects | Production namespace | Separate testing namespace |
| Jobs service binding | `runtime` | `testing` |
| Workflow names | Production names | `testing-` prefixed names |

The `fieldview-discovery-testing` R2 bucket must be created in the intended Cloudflare account before the testing Workers can be deployed. Do not point testing at the production bucket. Durable Object namespaces are scoped to their Worker service; the `runtime` and `testing` Workers therefore keep independent state and migration histories.

The Jobs Workers are internal service-binding targets and do not need public `workers.dev` URLs. Only the Runtime Workers expose the fixed runtime URLs.

## Deploy commands

Run from the repository root, after verifying the authenticated Cloudflare account and the target resources.

### From `main`

```sh
npx wrangler deploy --config workers/fieldview-runtime/wrangler.toml
npx wrangler deploy --config workers/fieldview-jobs/wrangler.toml
```

### From any non-main branch

```sh
npx wrangler deploy --config workers/fieldview-runtime/wrangler.testing.toml
npx wrangler deploy --config workers/fieldview-jobs/wrangler.testing.toml
```

Never deploy a non-main branch with the production configuration. Never deploy `main` with the testing configuration. These commands are documented for operators; this repository change does not add CI deployment automation or execute a Cloudflare deployment.

## Secrets and production readiness

Set secrets independently on each Worker in the selected environment. Never put secret values in Wrangler files, Git, or chat.

- Runtime: `TBA_API_KEY` and `TBA_WEBHOOK_SECRET`.
- Jobs: `TBA_API_KEY`.
- The current code also requires `RUNTIME_ADMIN_TOKEN` for internal Worker-to-Worker and administrative operations. This bearer-token mechanism is temporary testing authorization and is **not approved for production**. Production deployment remains blocked until the system-administrator authorization design replaces it. Do not copy a testing token into production.

The current production config intentionally contains no secret values. The testing environment may use its own testing credentials and temporary admin token, configured directly as Worker secrets.

## Existing prototype resources

The repository no longer contains prototype-named Wrangler files or a prototype setup runbook. This source change does not delete or modify the already-existing `fieldview-runtime-prototype` / `fieldview-jobs-prototype` Cloudflare services, their Durable Object data, or the old prototype R2 bucket. Those are remote resources and require a separate, explicit cleanup decision after the new testing environment is validated.

## Vercel

No Vercel project settings or environment variables are changed here. When the frontend is ready to consume the runtime, configure the server-only `FIELDVIEW_RUNTIME_URL` separately for Production and Preview in Vercel:

- Production: `https://runtime.frc-fieldview.workers.dev`
- Preview: `https://testing.frc-fieldview.workers.dev`

Only set the browser-exposed `NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL` if the relevant browser transport explicitly requires it, and only after its public-read/CORS behavior has been validated. Do not expose service credentials or admin tokens to browser code.
