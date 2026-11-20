import { getCanonicalDistrictDirectory } from "@/lib/events/serverSnapshot";

export async function GET() {
  const year = new Date().getFullYear();
  const directory = await getCanonicalDistrictDirectory(year);
  if (!directory) return Response.json({ error: "Canonical district directory is not available" }, { status: 503 });
  return Response.json(directory);
}
