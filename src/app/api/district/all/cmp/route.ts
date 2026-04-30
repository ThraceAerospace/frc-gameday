import { TBA } from "@/lib/tbaService";

export const dynamic = "force-static";
export const revalidate = 86400;

export async function GET() {
  const year = new Date().getFullYear();

  const data = await TBA.getAllDistrictTeamsAdvancedToCMP(year);

  return Response.json(data);
}