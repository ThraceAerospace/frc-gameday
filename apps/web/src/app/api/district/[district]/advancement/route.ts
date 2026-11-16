import { TBA } from "@/lib/tba/service";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ district: string }> }
) {
  const { district } = await params;
  const data = await TBA.getDistrictAdvancement(district);
  return Response.json(data);
}