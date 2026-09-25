import type { TBATeamEventStatus } from "@/lib/tba/types";

export default function Record({ status }: { status: TBATeamEventStatus | null | undefined }) {const r=status?.qual?.ranking?.record; return <span>{r?`${r.wins??0}-${r.losses??0}-${r.ties??0}`:"—"}</span>}
