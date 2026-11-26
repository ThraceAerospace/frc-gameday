# FieldView administrator authentication

**Status:** Worker-side Cloudflare Access verification and the Vercel
Command Center proxy integration are implemented on
`fieldview-architecture-migration`. The Cloudflare Access application,
custom-domain proxy configuration, and runtime environment values still need
to be provisioned. Until then, administrator endpoints fail closed.

## Request and authorization flow

The administrative panels live in the Next.js application deployed on Vercel.
The browser must reach that application through a Cloudflare-proxied custom
hostname protected by Cloudflare Access.

1. Cloudflare Access protects both `/admin/runtime*` and
   `/api/admin/runtime*` on the Vercel application's public custom hostname.
2. After successful identity authentication, Cloudflare injects the
   `Cf-Access-Jwt-Assertion` header on requests to the protected origin paths.
3. The Next.js API route requires that header and forwards it to the Runtime
   Worker. It no longer accepts a manually entered dashboard bearer token and
   does not forward the old service bearer token.
4. The Runtime Worker independently verifies the signed JWT and administrator
   allowlist before serving any `/internal/admin/*` operation.
5. The Worker's internal `RUNTIME_ADMIN_TOKEN` remains available only for
   private Worker-to-Worker, Durable Object, and Workflow calls.

The Next.js API route does not treat the presence of the header as proof of
identity. The Runtime Worker performs cryptographic verification, so requests
that bypass Cloudflare and reach the Vercel deployment directly cannot perform
administrative operations without a valid Access JWT.

## Worker-side JWT verification

Human administrator requests to `/internal/admin/*` must carry the
`Cf-Access-Jwt-Assertion` header. The Runtime Worker validates the JWT
signature against the team's published JWKS and checks:

- RS256 signature and signing-key ID
- Exact Access team issuer
- This application's Access audience tag
- Expiration, not-before, and issued-at timestamps
- An exact, case-insensitive email match in `RUNTIME_ADMIN_EMAILS`

The Worker does not trust `Cf-Access-Authenticated-User-Email`, an
`Authorization: Bearer` header, or an unsigned browser-supplied identity
header as human administrator authentication.

## Cloudflare Access application and Vercel

Create a **Self-hosted** Access application for the custom hostname assigned to
the Vercel project. The hostname must be an active Cloudflare zone hostname
and HTTP traffic must pass through Cloudflare. Protect these paths:

- `/admin/runtime*` — the Command Center UI
- `/api/admin/runtime*` — all Command Center reads and operations

Use an Allow policy with the exact administrator email address(es). Do not use
a broad email-domain policy for this administrator surface. The Access
application policy is the edge gate; `RUNTIME_ADMIN_EMAILS` is the independent
Worker-side authorization allowlist.

Because the origin is Vercel, configure the hostname as a supported Cloudflare
reverse-proxy path: keep the hostname assigned to the Vercel project, proxy
traffic through Cloudflare, use **Full (strict)** TLS, and preserve the
`CF-Connecting-IP` header required for Vercel Verified Proxy Lite. Disable
external caching for the Vercel origin unless separately designed and tested;
never cache admin API responses or `/.well-known/vercel/*`. Vercel documents
Cloudflare as a supported Verified Proxy Lite provider but warns that a proxy
reduces some security visibility and introduces an additional network/cache
layer.

Do not protect the entire FieldView hostname. Public FieldView pages and APIs
must remain publicly accessible. Access matching is limited to the two admin
paths above.

The direct `*.vercel.app` deployment hostname is not protected by this
custom-hostname Access application. The Runtime Worker still rejects admin
requests there unless the caller supplies a correctly signed, audience-bound
Access JWT for an allowlisted administrator. Consider Vercel Deployment
Protection for deployment URLs if hiding even the admin page shell is
required; do not assume the custom-domain Access policy protects Vercel's
deployment URLs.

## Runtime configuration

Configure these Worker environment variables in both Production and any
Preview environment that should support administrator operations:

| Variable | Value |
| --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | `https://<team-name>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Application Audience (AUD) tag from the Access application |
| `RUNTIME_ADMIN_EMAILS` | Comma-separated exact administrator email addresses |

Set these values as Worker environment variables through the Cloudflare
dashboard. They are intentionally not committed to Wrangler configuration.
Use a local-only `.dev.vars` file for local development and never commit it.

Keep `RUNTIME_ADMIN_TOKEN` configured as a Worker secret for internal
service-to-service calls. It is not a substitute for any of the three Access
settings above. Remove the obsolete `FIELDVIEW_ADMIN_ACCESS_TOKEN` from the
Vercel project once the Access-protected custom hostname and API proxy are
configured and validated.

## Validation and rollout

1. Identify the exact Vercel custom hostname used by FieldView.
2. Configure the Cloudflare-proxied hostname and verify Vercel Verified Proxy
   Lite prerequisites.
3. Create the path-scoped Access application for the two admin paths and its
   exact-email Allow policy.
4. Set the three Access variables in the Runtime Worker environment.
5. Confirm an allowlisted administrator can open the Command Center and use
   read and write operations.
6. Confirm a non-allowlisted authenticated user receives HTTP 401 from the
   Runtime Worker.
7. Confirm requests without `Cf-Access-Jwt-Assertion`, including requests
   carrying only the former dashboard bearer token, receive HTTP 401.
8. Confirm public event/team snapshots, analytics, streams, health, and TBA
   webhook behavior is unchanged.
9. Confirm direct Vercel deployment URLs cannot perform administrator
   operations and that Preview URLs are either protected separately or have
   no administrative access.

Worker tests cover signature, issuer, audience, expiry, not-before, future
issued-at, malformed tokens, algorithm restrictions, email allowlisting, and
the lightweight auth-check endpoint. No production Access application,
secret, Worker deployment, or traffic routing is changed by the code-only
implementation.
