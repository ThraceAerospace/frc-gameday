import type { ReactNode } from "react";
type Props = { children: ReactNode; className?: string; padding?: boolean; id?: string };
export default function SurfaceCard({ children, className = "", padding = false, id }: Props) {
  return <div id={id} className={["min-w-0 rounded-xl border border-[var(--fv-border)] bg-[var(--fv-surface-raised)] shadow-sm", padding ? "p-4 sm:p-5" : "", className].filter(Boolean).join(" ")}>{children}</div>;
}
