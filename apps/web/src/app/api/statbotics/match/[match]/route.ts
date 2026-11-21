export async function GET(
  _request: Request,
  { params }: { params: Promise<{ match: string }> },
) {
  const { match } = await params;

  // FRC match keys are scoped to an event (for example, 2026cthar_qm1).
  if (!match || !/^[a-zA-Z0-9_]+$/.test(match)) {
    return Response.json({ error: "Invalid match key" }, { status: 400 });
  }
  const separator = match.indexOf("_");
  const eventKey = separator > 0 ? match.slice(0, separator) : "";
  if (!/^[0-9]{4}[a-zA-Z0-9-]+$/.test(eventKey)) {
    return Response.json({ error: "Invalid event-scoped match key" }, { status: 400 });
  }

  const runtimeOrigin = process.env.NEXT_PUBLIC_FIELDVIEW_RUNTIME_URL;
  if (!runtimeOrigin) {
    return Response.json({ error: "FieldView runtime is not configured" }, { status: 503 });
  }

  try {
    const url = new URL(
      "/events/" + encodeURIComponent(eventKey) + "/statbotics-match?match_key=" + encodeURIComponent(match),
      runtimeOrigin,
    );
    const response = await fetch(url, { cache: "no-store" });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "FieldView runtime is temporarily unavailable" },
      { status: 502 },
    );
  }
}
