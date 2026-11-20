import { getCanonicalDistrictDirectory, getCanonicalDistrictSnapshot } from "@/lib/events/serverSnapshot";

export async function GET(_req: Request, { params }: { params: Promise<{ district: string }> }) {
  const { district: requestedKey } = await params;
  const year = new Date().getFullYear();
  const directory = await getCanonicalDistrictDirectory(year);
  const record = directory?.districts?.find((item) =>
    item.abbreviation.toLowerCase() === requestedKey.toLowerCase() ||
    item.key.toLowerCase() === requestedKey.toLowerCase());
  if (!record) return Response.json({ error: "District is not available in the canonical directory" }, { status: 404 });
  const snapshot = await getCanonicalDistrictSnapshot(record.key, year);
  if (!snapshot || snapshot.advancement === undefined) return Response.json({ error: "District advancement has not been acquired" }, { status: 503 });
  return Response.json(snapshot.advancement);
}
