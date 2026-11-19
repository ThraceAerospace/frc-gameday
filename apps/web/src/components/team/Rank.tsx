import type { FieldViewEventTeam } from "@fieldview/domain";

export default function Rank({ status }: { status: FieldViewEventTeam["tba_status"] | null | undefined }) {const rank=status?.qual?.ranking?.rank; return <span>Rank {rank??"—"}</span>}
