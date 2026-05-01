import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const key = body?.key;

    if (!key || typeof key !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid key" },
        { status: 400 }
      );
    }

    // Safety: prevent accidental mass deletion
    if (key === "*" || key === "all") {
      return NextResponse.json(
        { error: "Refusing to delete all keys" },
        { status: 400 }
      );
    }

    await redis.del(key);

    return NextResponse.json({
      ok: true,
      deleted: key,
    });
  } catch (err) {
    console.error("[REDIS DELETE ERROR]", err);

    return NextResponse.json(
      { error: "Failed to delete key" },
      { status: 500 }
    );
  }
}