import { getEventState, getKey } from "@/lib/eventState";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ key?: string}>;
}) {
  const { key } = await searchParams;

  const eventKey = key as string;
  const tbaEventKey = eventKey.split(":")[1];
  console.log("eventKey:", eventKey);
  const state = await getKey(eventKey);
  return (
    <div>
      <h2>Event: { eventKey}</h2>
      <form method="POST" action="/api/admin/rebuild">
        <input type="hidden" name="eventKey" value={eventKey} />
        <input type="hidden" name="tbaEventKey" value={tbaEventKey} />
        <button className="btn btn-warning">Force Rebuild</button>
      </form>
      <form method="POST" action="/api/admin/set">
        <input type="hidden" name="eventKey" value={eventKey} />
        <input type="hidden" name="tbaEventKey" value={tbaEventKey} />
        <input type="hidden" name="value" value={JSON.stringify({})} />
        <button className="btn btn-danger">Flush</button>
      </form>
      <pre
        style={{
          background: "#111",
          color: "#0f0",
          padding: 12,
          overflow: "auto",
        }}
      >
        {JSON.stringify(state, null, 2)}
      </pre>

    </div>
  );
}