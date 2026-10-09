const DEFAULT_STATBOTICS_API_BASE_URL =
  "https://api-statbotics.iterativerefinement.com";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ match: string }> },
) {
  const { match } = await params;

  // FRC match keys contain only letters, digits, and underscores. Reject
  // anything else rather than allowing the route to become a URL proxy.
  if (!match || !/^[a-zA-Z0-9_]+$/.test(match)) {
    return Response.json({ error: "Invalid match key" }, { status: 400 });
  }

  const configuredBase = process.env.STATBOTICS_API_BASE_URL?.trim();
  const baseUrl = (configuredBase || DEFAULT_STATBOTICS_API_BASE_URL).replace(/\/+$/, "");

  try {
    const response = await fetch(
      `${baseUrl}/v3/match/${encodeURIComponent(match)}`,
      { cache: "no-store" },
    );

    if (response.status === 404) {
      return Response.json({ available: false }, { status: 404 });
    }

    if (!response.ok) {
      return Response.json(
        { error: "Statbotics request failed", status: response.status },
        { status: 502 },
      );
    }

    return Response.json(await response.json(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Statbotics service is temporarily unavailable" },
      { status: 502 },
    );
  }
}
