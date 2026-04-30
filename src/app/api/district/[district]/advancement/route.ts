import { TBA } from "@/lib/tbaService";
export const revalidate = 86000;
export async function GET(
  req: Request,
  { params }: { params: Promise<{ district: string }> }
) {
  const { district } = await params;
  const data = await TBA.getDistrictAdvancement(district);
  return Response.json(data);
}