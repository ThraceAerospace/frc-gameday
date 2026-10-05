import type { TBATeamEventStatus } from "@/lib/tba/types";

export default function Rank({ status }: { status: TBATeamEventStatus | null | undefined }) {const rank=status?.qual?.ranking?.rank; return <span>Rank {rank??"—"}</span>}
