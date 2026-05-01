import { NextResponse } from "next/server";
import { getAllEventKeys, getEventState } from "@/lib/eventState";

export async function GET() {
  const keys = await getAllEventKeys();

  const data = await Promise.all(
    keys.map(async (key) => ({
      key,
      state: await getEventState(key),
    }))
  );

  return NextResponse.json(data);
}