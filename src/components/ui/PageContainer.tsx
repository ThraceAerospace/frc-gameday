import type { ReactNode } from "react";
type Props = { children: ReactNode; className?: string };
export default function PageContainer({ children, className = "" }: Props) {
  return <div className={["mx-0 w-full min-w-0 max-w-none px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10", className].filter(Boolean).join(" ")}>{children}</div>;
}
