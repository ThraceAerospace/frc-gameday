import { TBA } from "@/lib/tbaService";
export const revalidate = 86000;
export async function GET(
  req: Request,
) {
  const year = new Date().getFullYear();

  const data = await TBA.getAllDistrictTeamsAdvancedToCMP(year);

  return Response.json(data);
}