import type { ReactNode } from "react";
type Props = { title: ReactNode; eyebrow?: ReactNode; description?: ReactNode; leading?: ReactNode; actions?: ReactNode; footer?: ReactNode; className?: string };
export default function PageHeader({ title, eyebrow, description, leading, actions, footer, className = "" }: Props) {
  return (
    <header className={["flex min-w-0 flex-col gap-4 border-b border-[var(--fv-border)] pb-6 sm:flex-row sm:items-start sm:justify-between", className].filter(Boolean).join(" ")}>
      <div className="flex min-w-0 items-start gap-4">
        {leading ? <div className="shrink-0">{leading}</div> : null}
        <div className="min-w-0">
          {eyebrow ? <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--fv-brand)]">{eyebrow}</p> : null}
          <h1 className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-2xl font-black tracking-tight text-[var(--fv-text)] sm:text-3xl">{title}</h1>
          {description ? <div className="mt-2 text-sm leading-relaxed text-[var(--fv-muted)]">{description}</div> : null}
          {footer ? <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--fv-muted)]">{footer}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
    </header>
  );
}
