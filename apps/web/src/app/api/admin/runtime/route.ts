import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getCanonicalCurrentSeason } from "@/lib/events/serverSnapshot";

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
  const workflowRunsType = query.get("workflowRuns");
  const workflowRunId = query.get("runId");
  const needsDefaultYear = Boolean(teamSeedKey || (kind && key) || inventoryKind);
  const currentSeason = !query.get("year") && needsDefaultYear
    ? await getCanonicalCurrentSeason()
    : null;
  const defaultYear = query.get("year") ?? (currentSeason ? String(currentSeason.year) : null);
  if (needsDefaultYear && !defaultYear) {
    return NextResponse.json({ error: "TBA current season is unavailable" }, { status: 503 });
  }
  const target = workflowRunsType ? "/internal/admin/workflow-runs?" + new URLSearchParams({
    type: workflowRunsType,
    ...(workflowRunId ? { id: workflowRunId } : {}),
    ...(query.get("limit") ? { limit: query.get("limit")! } : {}),
  }).toString()
    : teamSeedKey ? "/internal/admin/team-seed?" + new URLSearchParams({
    team_key: teamSeedKey,
    year: defaultYear!,
  }).toString()
    : discoveryJobYear ? "/internal/admin/discovery-job?" + new URLSearchParams({ year: discoveryJobYear }).toString()
    : eventSeedKey ? "/internal/admin/event-team-seed?" + new URLSearchParams({
    event_key: eventSeedKey,
    ...(query.get("year") ? { year: query.get("year")! } : {}),
  }).toString()
    : seasonIngestYear ? "/internal/admin/season-ingest?year=" + encodeURIComponent(seasonIngestYear)
    : coverageAuditYear ? "/internal/admin/coverage-audit?year=" + encodeURIComponent(coverageAuditYear)
    : kind && key ? "/internal/admin/entity?kind=" + encodeURIComponent(kind) + "&key=" + encodeURIComponent(key) + "&year=" + encodeURIComponent(defaultYear!)
    : inventoryKind ? "/internal/admin/inventory?" + new URLSearchParams({
      kind: inventoryKind,
      q: query.get("q") ?? "",
      cursor: query.get("cursor") ?? "0",
      limit: query.get("limit") ?? "50",
      year: defaultYear!,
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
  const workflowType = (body as Record<string, unknown>).workflowType;
  if (workflowType === "events-this-week") {
    try {
      const response = await fetch(new URL("/internal/admin/events-this-week/refresh", runtimeUrl), {
        method: "POST",
        headers: { Authorization: "Bearer " + runtimeToken },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => ({ error: "Runtime returned invalid JSON" }));
      return NextResponse.json(result, { status: response.status, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to dispatch weekly event projection refresh" }, { status: 502 });
    }
  }
  if (workflowType === "event-readiness" || workflowType === "team-readiness") {
    try {
      const path = workflowType === "event-readiness"
        ? "/internal/admin/daily-event-readiness"
        : "/internal/admin/daily-team-readiness";
      const response = await fetch(new URL(path, runtimeUrl), {
        method: "POST",
        headers: { Authorization: "Bearer " + runtimeToken },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => ({ error: "Runtime returned invalid JSON" }));
      return NextResponse.json(result, { status: response.status, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to dispatch readiness workflow" }, { status: 502 });
    }
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
