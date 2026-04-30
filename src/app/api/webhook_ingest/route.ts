export async function POST(req: Request) {
  const event = await req.json();

  const eventKey = event?.event_key;
  if (!eventKey) return new Response("bad payload", { status: 400 });

  if (event.type === "ping") {
        console.log("Received ping from TBA", event);
    return new Response("ok");
  }
  // Only act on meaningful updates
  if (event.type === "match" || event.type === "alliance" || event.type === "rankings") {
    //await invalidateEvent(eventKey);
  }

  return new Response("ok");
}