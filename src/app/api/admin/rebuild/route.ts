import { NextResponse } from "next/server";
import { buildEventState, setEventState } from "@/lib/eventState";
import { revalidateTag } from "next/cache";

export async function POST(req: Request) {
  const form = await req.formData();
  const eventKey = form.get("eventKey") as string;
  const tbaKey = form.get("tbaEventKey") as string;

  if (!eventKey) {
    return NextResponse.json({ error: "missing key" }, { status: 400 });
  }

  const rebuilt = await buildEventState(tbaKey);
  await setEventState(tbaKey, rebuilt);

  revalidateTag(`state:${tbaKey}`, "max");

  return NextResponse.redirect(
        new URL(`/admin/events?key=${eventKey}`, req.url)
    );
}