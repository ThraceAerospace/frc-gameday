import type { ReactNode } from "react";
import { SharedLiveRuntimeProvider } from "@/lib/events/SharedLiveRuntimeProvider";

export default function InsightsLiveLayout({ children }: { children: ReactNode }) {
  return <SharedLiveRuntimeProvider>{children}</SharedLiveRuntimeProvider>;
}
