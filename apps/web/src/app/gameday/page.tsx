"use client";

import { use } from "react";
import TileViewSurface from "@/components/surface/TileViewSurface";

function normalizeParams(param: string | string[] | undefined): string[] {
  if (!param) return [];
  return Array.isArray(param) ? param : [param];
}

export default function GamedayPage({ searchParams }: { searchParams: Promise<{ event?: string | string[] }> }) {
  const params = use(searchParams);
  const eventKeys = normalizeParams(params?.event);

  // An empty event list is a valid starting state. TileViewSurface renders a
  // single empty slot, while retaining the normal controller/settings flow.
  return <TileViewSurface events={eventKeys} isDivisional={false} />;
}
