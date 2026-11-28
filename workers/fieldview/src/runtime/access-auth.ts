/**
 * Verify a Cloudflare Access user JWT and enforce FieldView's administrator
 * allowlist. Access at the edge is not sufficient: workers.dev and alternate
 * routes can otherwise bypass an application-level policy.
 */
interface AccessEnvironment {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  RUNTIME_ADMIN_EMAILS?: string;
  /** Explicit Wrangler-local bypass; never configured in deployed Worker vars. */
  LOCAL_ADMIN_AUTH?: string;
  fetcher?: typeof fetch;
}

interface AccessClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  email?: unknown;
}

interface AccessJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface AccessJwkSet {
  keys?: AccessJwk[];
}

interface CachedJwks {
  keys: AccessJwk[];
  expiresAt: number;
}

class AccessVerificationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "AccessVerificationError";
    this.reason = reason;
  }
}

const jwksCache = new Map<string, CachedJwks>();
const MAX_TOKEN_LENGTH = 16_384;
const DEFAULT_JWKS_TTL_MS = 5 * 60_000;
const MAX_JWKS_TTL_MS = 60 * 60_000;

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonPart<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function normalizeTeamDomain(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : "https://" + value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash ||
        !url.hostname.endsWith(".cloudflareaccess.com")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredAdminEmails(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(/[\s,;]+/).map((email) => email.trim().toLowerCase())
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)));
}

async function loadJwks(
  issuer: string,
  fetcher: typeof fetch,
  forceRefresh = false,
): Promise<AccessJwk[]> {
  const now = Date.now();
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.keys;

  let response: Response;
  try {
    response = await fetcher(issuer + "/cdn-cgi/access/certs", {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
  } catch {
    throw new AccessVerificationError("jwks_fetch_failed");
  }
  if (!response.ok) throw new AccessVerificationError("jwks_http_" + response.status);
  let body: AccessJwkSet;
  try {
    body = await response.json() as AccessJwkSet;
  } catch {
    throw new AccessVerificationError("jwks_invalid_json");
  }
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new AccessVerificationError("jwks_missing_keys");
  }

  const cacheControl = response.headers.get("Cache-Control") ?? "";
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
  const ttl = maxAge
    ? Math.min(MAX_JWKS_TTL_MS, Math.max(30_000, Number(maxAge[1]) * 1000))
    : DEFAULT_JWKS_TTL_MS;
  jwksCache.set(issuer, { keys: body.keys, expiresAt: now + ttl });
  return body.keys;
}

async function verifySignature(
  tokenParts: string[],
  issuer: string,
  fetcher: typeof fetch,
): Promise<boolean> {
  const [encodedHeader, encodedPayload, encodedSignature] = tokenParts;
  const header = decodeJsonPart<{ alg?: unknown; kid?: unknown }>(encodedHeader);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return false;
  const signatureBytes = decodeBase64Url(encodedSignature);
  const signature = new ArrayBuffer(signatureBytes.byteLength);
  new Uint8Array(signature).set(signatureBytes);
  const signingInputBytes = new TextEncoder().encode(encodedHeader + "." + encodedPayload);
  const signingInput = new ArrayBuffer(signingInputBytes.byteLength);
  new Uint8Array(signingInput).set(signingInputBytes);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const keys = await loadJwks(issuer, fetcher, attempt === 1);
    const jwk = keys.find((key) => key.kid === header.kid &&
      (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
    if (!jwk) continue;
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      throw new AccessVerificationError("signing_key_import_failed");
    }
    let valid: boolean;
    try {
      valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signingInput);
    } catch {
      throw new AccessVerificationError("signature_verification_error");
    }
    if (!valid) throw new AccessVerificationError("signature_invalid");
    return true;
  }
  throw new AccessVerificationError("signing_key_not_found");
}

/**
 * Returns true only for a correctly signed, unexpired Access user JWT whose
 * issuer/audience match this app and whose email is in the explicit allowlist.
 * Missing configuration and every verification/network error fail closed.
 */
function isExplicitLocalAdminRequest(request: Request, env: AccessEnvironment): boolean {
  if (env.LOCAL_ADMIN_AUTH?.trim().toLowerCase() !== "true") return false;
  try {
    const url = new URL(request.url);
    return url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export async function isCloudflareAccessAdmin(
  request: Request,
  env: AccessEnvironment,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  // Wrangler's [dev.vars] is local-only. Keep the bypass constrained to an
  // explicitly enabled, plain-HTTP loopback request; deployed hosts still
  // require a signed Cloudflare Access JWT and the administrator allowlist.
  if (isExplicitLocalAdminRequest(request, env)) return true;

  // Keep the public response generic, but emit a safe reason code so failures
  // can be diagnosed from Workers Observability without ever logging a JWT,
  // identity claim, email address, or signing material.
  const reject = (reason: string): false => {
    console.warn("[AUTH] Cloudflare Access administrator verification rejected", { reason });
    return false;
  };
  const issuer = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const audience = env.CF_ACCESS_AUD?.trim();
  const allowlist = configuredAdminEmails(env.RUNTIME_ADMIN_EMAILS);
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!issuer) return reject("invalid_or_missing_team_domain");
  if (!audience) return reject("missing_application_audience");
  if (allowlist.size === 0) return reject("empty_administrator_allowlist");
  if (!token) return reject("access_jwt_header_missing");
  if (token.length > MAX_TOKEN_LENGTH) return reject("access_jwt_too_large");

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return reject("access_jwt_structure_invalid");
  }

  try {
    const claims = decodeJsonPart<AccessClaims>(parts[1]);
    const audiences = typeof claims.aud === "string"
      ? [claims.aud]
      : Array.isArray(claims.aud) ? claims.aud : [];
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (claims.iss !== issuer) return reject("issuer_claim_mismatch");
    if (!audiences.includes(audience)) return reject("audience_claim_mismatch");
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) {
      return reject("expiration_claim_invalid");
    }
    if (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds)) {
      return reject("not_before_claim_invalid");
    }
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > nowSeconds + 60) {
      return reject("issued_at_claim_invalid");
    }
    if (!allowlist.has(email)) return reject("identity_not_allowlisted");

    if (!await verifySignature(parts, issuer, env.fetcher ?? fetch)) {
      return reject("signature_invalid");
    }
    return true;
  } catch (error) {
    return reject(error instanceof AccessVerificationError
      ? error.reason
      : "jwks_or_signature_unexpected_error");
  }
}
