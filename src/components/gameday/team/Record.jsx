export default function Record({status}){const r=status?.qual?.ranking?.record; return <span>{r?`${r.wins??0}-${r.losses??0}-${r.ties??0}`:"—"}</span>}
