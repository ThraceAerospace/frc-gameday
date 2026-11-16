import type { ReactNode } from "react";
type Props = { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string };
export default function SectionHeading({ title, description, action, className = "" }: Props) {
  return (
    <div className={["flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className].filter(Boolean).join(" ")}>
      <div className="min-w-0"><h2 className="text-lg font-bold tracking-tight text-[var(--fv-text)] sm:text-xl">{title}</h2>{description ? <p className="mt-1 text-sm text-[var(--fv-muted)]">{description}</p> : null}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
