import { getCanonicalDistrictDirectory, getCanonicalDistrictSnapshot } from "@/lib/events/serverSnapshot";

export async function GET(_req: Request, { params }: { params: Promise<{ district: string }> }) {
  const { district: requestedKey } = await params;
  const year = new Date().getFullYear();
  const directory = await getCanonicalDistrictDirectory(year);
  const district = directory?.districts?.find((item) =>
    item.abbreviation.toLowerCase() === requestedKey.toLowerCase() ||
    item.key.toLowerCase() === requestedKey.toLowerCase());
  if (!district) return Response.json({ error: "District is not available in the canonical directory" }, { status: 404 });
  const snapshot = await getCanonicalDistrictSnapshot(district.key, year);
  if (!snapshot || snapshot.advancement === undefined) return Response.json({ error: "District advancement has not been acquired" }, { status: 503 });
  const teams = snapshot.advancement?.teams ?? {};
  return Response.json(Object.entries(teams)
    .filter(([, status]) => status.cmp === true)
    .map(([key, status]) => ({
      key, ...status, district_key: district.key,
      district_abbreviation: district.key.replace(/[0-9]/g, "").toUpperCase(),
    })));
}
