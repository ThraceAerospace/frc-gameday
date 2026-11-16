import { TBA } from "@/lib/tba/service";

export async function GET() {
  const year = new Date().getFullYear();

  const data = await TBA.getAllDistrictTeamsAdvancedToCMP(year);

  return Response.json(data);
}