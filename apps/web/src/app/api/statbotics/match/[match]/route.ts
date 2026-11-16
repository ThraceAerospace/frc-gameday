import { Statbotics } from "@/lib/statbotics/service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ match: string }> },
) {
  const { match } = await params;

  // Match keys are identifiers, not arbitrary paths or URLs.
  if (!match || !/^[a-zA-Z0-9_]+$/.test(match)) {
    return Response.json({ error: "Invalid match key" }, { status: 400 });
  }

  try {
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    const data = await Statbotics.getMatch(match, { refresh });

    if (!data) {
      return Response.json({ available: false }, { status: 404 });
    }

    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Statbotics service is temporarily unavailable" },
      { status: 502 },
    );
  }
}
