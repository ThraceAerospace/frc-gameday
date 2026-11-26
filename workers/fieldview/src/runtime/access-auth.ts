/**
 * Verify a Cloudflare Access user JWT and enforce FieldView's administrator
 * allowlist. Access at the edge is not sufficient: workers.dev and alternate
 * routes can otherwise bypass an application-level policy.
 */
interface AccessEnvironment {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  RUNTIME_ADMIN_EMAILS?: string;
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

interface AccessJwkSet {
  keys?: JsonWebKey[];
}

interface CachedJwks {
  keys: JsonWebKey[];
  expiresAt: number;
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
): Promise<JsonWebKey[]> {
  const now = Date.now();
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.keys;

  const response = await fetcher(issuer + "/cdn-cgi/access/certs", {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error("Cloudflare Access JWKS request failed");
  const body = await response.json() as AccessJwkSet;
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error("Cloudflare Access JWKS response contained no keys");
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
  const signature = decodeBase64Url(encodedSignature);
  const signingInput = new TextEncoder().encode(encodedHeader + "." + encodedPayload);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const keys = await loadJwks(issuer, fetcher, attempt === 1);
    const jwk = keys.find((key) => key.kid === header.kid &&
      (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
    if (!jwk) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signingInput);
  }
  return false;
}

/**
 * Returns true only for a correctly signed, unexpired Access user JWT whose
 * issuer/audience match this app and whose email is in the explicit allowlist.
 * Missing configuration and every verification/network error fail closed.
 */
export async function isCloudflareAccessAdmin(
  request: Request,
  env: AccessEnvironment,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const issuer = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const audience = env.CF_ACCESS_AUD?.trim();
  const allowlist = configuredAdminEmails(env.RUNTIME_ADMIN_EMAILS);
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!issuer || !audience || allowlist.size === 0 || !token || token.length > MAX_TOKEN_LENGTH) {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return false;

  try {
    const claims = decodeJsonPart<AccessClaims>(parts[1]);
    const audiences = typeof claims.aud === "string"
      ? [claims.aud]
      : Array.isArray(claims.aud) ? claims.aud : [];
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (claims.iss !== issuer || !audiences.includes(audience) ||
        typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds ||
        (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds)) ||
        typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > nowSeconds + 60 ||
        !allowlist.has(email)) return false;

    return await verifySignature(parts, issuer, env.fetcher ?? fetch);
  } catch {
    return false;
  }
}
