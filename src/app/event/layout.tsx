import type { ReactNode } from "react";
import { SharedLiveRuntimeProvider } from "@/lib/events/SharedLiveRuntimeProvider";

export default function EventLiveLayout({ children }: { children: ReactNode }) {
  return <SharedLiveRuntimeProvider>{children}</SharedLiveRuntimeProvider>;
}
