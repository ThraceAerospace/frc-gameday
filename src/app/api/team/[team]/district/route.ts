import { TBA } from "@/lib/tbaService";
export const revalidate = 86000;
export async function GET(
  req: Request,
  { params }: { params: Promise<{ team: string }> }
) {
  const { team } = await params;
  const year = new Date().getFullYear();
  const data = await TBA.getTeamDistricts(team);
  const current = data.find((d: any) => d.year === year) || null;
  return Response.json(current);
}