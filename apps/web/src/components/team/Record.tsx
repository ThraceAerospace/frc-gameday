import type { FieldViewEventTeam } from "@fieldview/domain";

export default function Record({ status }: { status: FieldViewEventTeam["tba_status"] | undefined }) {const r=status?.qual?.ranking?.record; return <span>{r?`${r.wins??0}-${r.losses??0}-${r.ties??0}`:"—"}</span>}
