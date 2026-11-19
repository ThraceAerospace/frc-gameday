export async function GET(request: Request, { params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const target = new URL(`/api/team/${encodeURIComponent(team)}/matches`, request.url);
  target.search = new URL(request.url).search;
  return Response.redirect(target, 307);
}
