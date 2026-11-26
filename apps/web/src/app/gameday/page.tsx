"use client";

import { use } from "react";
import RemoteDisplaySession from "@/components/remote/RemoteDisplaySession";

function normalizeParams(param: string | string[] | undefined): string[] {
  if (!param) return [];
  return Array.isArray(param) ? param : [param];
}

export default function GamedayPage({ searchParams }: { searchParams: Promise<{ event?: string | string[] }> }) {
  const params = use(searchParams);
  const eventKeys = normalizeParams(params?.event);

  // An empty event list is a valid starting state. TileViewSurface renders a
  // single empty slot, while retaining the normal controller/settings flow.
  return <RemoteDisplaySession events={eventKeys} compact />;
}
