import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function validAdminToken(request: Request): boolean {
  const expected = process.env.FIELDVIEW_ADMIN_ACCESS_TOKEN;
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export async function GET(request: Request) {
  if (!validAdminToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Authentication is a local credential check. Do not make login depend on
  // TaskScheduler availability or Durable Object health.
  if (new URL(request.url).searchParams.get("auth") === "1") {
    return NextResponse.json({ authenticated: true }, { headers: { "Cache-Control": "no-store" } });
  }
  const runtimeUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  const runtimeToken = process.env.RUNTIME_ADMIN_TOKEN;
  if (!runtimeUrl || !runtimeToken) {
    return NextResponse.json({
      error: "Admin runtime configuration is incomplete. Configure NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL and the server-only RUNTIME_ADMIN_TOKEN.",
    }, { status: 503 });
  }
  const query = new URL(request.url).searchParams;
  const kind = query.get("kind");
  const key = query.get("key");
  const inventoryKind = query.get("inventory");
  const coverageAuditYear = query.get("coverageAudit");
  const seasonIngestYear = query.get("seasonIngest");
  const eventSeedKey = query.get("eventSeed");
  const teamSeedKey = query.get("teamSeed");
  const discoveryJobYear = query.get("discoveryJob");
  const discoveryJobMode = "year";
  const target = teamSeedKey ? "/internal/admin/team-seed?" + new URLSearchParams({
    team_key: teamSeedKey,
    year: query.get("year") ?? String(new Date().getUTCFullYear()),
  }).toString()
    : discoveryJobYear ? "/internal/admin/discovery-job?" + new URLSearchParams({ year: discoveryJobYear, mode: discoveryJobMode }).toString()
    : eventSeedKey ? "/internal/admin/event-team-seed?" + new URLSearchParams({
    event_key: eventSeedKey,
    ...(query.get("year") ? { year: query.get("year")! } : {}),
  }).toString()
    : seasonIngestYear ? "/internal/admin/season-ingest?year=" + encodeURIComponent(seasonIngestYear)
    : coverageAuditYear ? "/internal/admin/coverage-audit?year=" + encodeURIComponent(coverageAuditYear)
    : kind && key ? "/internal/admin/entity?kind=" + encodeURIComponent(kind) + "&key=" + encodeURIComponent(key) + "&year=" + encodeURIComponent(query.get("year") ?? String(new Date().getUTCFullYear()))
    : inventoryKind ? "/internal/admin/inventory?" + new URLSearchParams({
      kind: inventoryKind,
      q: query.get("q") ?? "",
      cursor: query.get("cursor") ?? "0",
      limit: query.get("limit") ?? "50",
      year: query.get("year") ?? String(new Date().getUTCFullYear()),
    }).toString()
    : "/internal/admin/overview";
  try {
    const response = await fetch(new URL(target, runtimeUrl), {
      headers: { Authorization: "Bearer " + runtimeToken },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({ error: "Runtime returned invalid JSON" }));
    return NextResponse.json(body, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to reach FieldView runtime",
    }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!validAdminToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const runtimeUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  const runtimeToken = process.env.RUNTIME_ADMIN_TOKEN;
  if (!runtimeUrl || !runtimeToken) {
    return NextResponse.json({ error: "Admin runtime configuration is incomplete." }, { status: 503 });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid operation payload" }, { status: 400 });
  }
  try {
    const response = await fetch(new URL("/internal/admin/operations", runtimeUrl), {
      method: "POST",
      headers: { Authorization: "Bearer " + runtimeToken, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({ error: "Runtime returned invalid JSON" }));
    return NextResponse.json(result, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to dispatch runtime operation" }, { status: 502 });
  }
}
