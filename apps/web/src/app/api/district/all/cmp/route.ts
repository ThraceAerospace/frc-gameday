import { getCanonicalDistrictDirectory, getCanonicalDistrictSnapshot } from "@/lib/events/serverSnapshot";

export async function GET() {
  const year = new Date().getFullYear();
  const directory = await getCanonicalDistrictDirectory(year);
  if (!directory?.districts) return Response.json({ error: "Canonical district directory is not available" }, { status: 503 });
  const snapshots = await Promise.all(directory.districts.map((district) =>
    getCanonicalDistrictSnapshot(district.key, year)));
  if (snapshots.some((snapshot) => !snapshot || snapshot.advancement === undefined)) {
    return Response.json({ error: "One or more district advancement resources have not been acquired" }, { status: 503 });
  }
  return Response.json(snapshots.flatMap((snapshot) => {
    const teams = snapshot?.advancement?.teams ?? {};
    return Object.entries(teams)
      .filter(([, status]) => status.cmp === true)
      .map(([key, status]) => ({
        key, ...status, district_key: snapshot!.district_key,
        district_abbreviation: snapshot!.district_key.replace(/[0-9]/g, "").toUpperCase(),
      }));
  }));
}
