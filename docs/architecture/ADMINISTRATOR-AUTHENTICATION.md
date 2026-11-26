# FieldView administrator authentication

**Status:** Worker-side Cloudflare Access verification is implemented on
`fieldview-architecture-migration`. The live Access application and runtime
configuration are not provisioned yet. Administrative routes fail closed until
all required values are configured.

## Authorization model

Human administrator requests to `/internal/admin/*` must carry the
`Cf-Access-Jwt-Assertion` header issued by Cloudflare Access. The Runtime Worker
validates the JWT signature against the team's published JWKS and checks:

- RS256 signature and signing-key ID
- Exact Access team issuer
- This application’s Access audience tag
- Expiration, not-before, and issued-at timestamps
- An exact, case-insensitive email match in `RUNTIME_ADMIN_EMAILS`

The Worker does not trust `Cf-Access-Authenticated-User-Email` or a browser
supplied bearer token. A request with only the old service bearer token is not
authorized for human administrator routes.

The existing `RUNTIME_ADMIN_TOKEN` is retained only for private
Worker-to-Worker / Durable Object / in-process Workflow calls. It must never be
sent to browser code, exposed by a frontend bundle, or accepted as the
administrator identity. Keep it as a Worker secret while internal service
authentication is migrated separately.

Public event/team reads and TBA webhook ingress remain outside the
administrator path. Do not enable a Worker-wide Access gate that unintentionally
makes public FieldView endpoints require an interactive login.

## Cloudflare Access application

Create a **Self-hosted** Access application scoped to the Runtime Worker
hostname and the path `/internal/admin/*` (not the entire Worker hostname).
For the current Wrangler configuration, the production hostname is
`runtime.frc-fieldview.workers.dev`.

Attach an Allow policy with the exact administrator email address(es). Do not
use a broad email-domain policy for this administrator surface. The application
policy is the edge gate; `RUNTIME_ADMIN_EMAILS` is the independent Worker-side
authorization allowlist.

If Preview administrative routes are needed, add Access coverage for the
actual Preview hostname pattern as a separate, narrowly scoped application or
policy. Do not assume production hostname coverage automatically protects
Preview URLs. Until configured, Preview admin routes must remain inaccessible
(fail closed).

## Runtime configuration

Configure these Worker environment variables in both Production and any
Preview environment that should support administrator operations:

| Variable | Value |
| --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | `https://<team-name>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Application Audience (AUD) tag from the Access application |
| `RUNTIME_ADMIN_EMAILS` | Comma-separated exact administrator email addresses |

Use the Worker dashboard's Variables and Secrets settings for Production and
Preview values. These values are intentionally not committed to Wrangler
configuration. For local development, use a local-only `.dev.vars` file and
never commit it.

Keep `RUNTIME_ADMIN_TOKEN` configured as a Worker secret for internal
service-to-service calls. It is not a substitute for any of the three Access
settings above.

## Validation and rollout

1. Configure the Access application and its exact-email Allow policy.
2. Set the three Access variables in the target Worker environment.
3. Confirm an allowlisted administrator can authenticate and use the command
   center.
4. Confirm a non-allowlisted authenticated user receives HTTP 401 from an
   administrator endpoint.
5. Confirm a request without `Cf-Access-Jwt-Assertion`, including one with
   only `Authorization: Bearer ...`, receives HTTP 401.
6. Confirm public event/team snapshot, analytics, stream, health, and webhook
   behavior is unchanged.
7. Confirm a direct request to the Worker hostname cannot bypass the Access
   app and that alternate hostnames / Preview URLs are either covered or have
   no administrator access.

The Worker verifier tests cover signature, issuer, audience, expiry, not-before,
future issued-at, malformed tokens, algorithm restrictions, and the email
allowlist. No production Access application, secret, Worker deployment, or
traffic routing is changed by the code-only implementation.
