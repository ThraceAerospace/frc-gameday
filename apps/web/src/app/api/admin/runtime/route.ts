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
  const runtimeUrl = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  const runtimeToken = process.env.RUNTIME_ADMIN_TOKEN;
  if (!runtimeUrl || !runtimeToken) {
    return NextResponse.json({
      error: "Admin runtime configuration is incomplete. Configure NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL and the server-only RUNTIME_ADMIN_TOKEN.",
    }, { status: 503 });
  }
  try {
    const response = await fetch(new URL("/internal/admin/overview", runtimeUrl), {
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
