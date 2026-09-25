import type { WebSocket } from "ws";
import { redis } from "@/lib/cache/redis";

export const TBA_WEBSOCKET_CHANNEL =
  "gameday:tba";

type ConnectedClient = {
  socket: WebSocket;
  eventKey: string;
};

type TBAWebSocketEvent = {
  type: "tba-update";
  eventKey: string;
  messageType?: string;
};

const clients = new Set<ConnectedClient>();

let subscriberStarted = false;

async function ensureSubscriber() {
  if (subscriberStarted) {
    return;
  }

  subscriberStarted = true;

  const subscriber = redis.duplicate();

  subscriber.on("error", (error) => {
    console.error(
      "[WSS] Redis subscriber error:",
      error,
    );
  });

  await subscriber.subscribe(
    TBA_WEBSOCKET_CHANNEL,
  );

  subscriber.on(
    "message",
    (channel, message) => {
      if (
        channel !== TBA_WEBSOCKET_CHANNEL
      ) {
        return;
      }

      let event: TBAWebSocketEvent;

      try {
        event = JSON.parse(
          message,
        ) as TBAWebSocketEvent;
      } catch (error) {
        console.error(
          "[WSS] Invalid Redis message:",
          error,
        );
        return;
      }

      for (const client of clients) {
        if (
          client.eventKey !== event.eventKey
        ) {
          continue;
        }

        if (
          client.socket.readyState !== 1
        ) {
          clients.delete(client);
          continue;
        }

        try {
          client.socket.send(
            JSON.stringify(event),
          );
        } catch (error) {
          console.error(
            "[WSS] Failed to send event:",
            error,
          );

          clients.delete(client);
        }
      }
    },
  );

  console.log("[WSS] Redis subscriber started");
}

export function registerWebSocket(
  socket: WebSocket,
  eventKey: string,
) {
  const client = {
    socket,
    eventKey,
  };

  clients.add(client);

  void ensureSubscriber();

  console.log(
    `[WSS] Connected: ${eventKey} (${clients.size} local clients)`,
  );

  socket.on("close", () => {
    clients.delete(client);

    console.log(
      `[WSS] Disconnected: ${eventKey} (${clients.size} local clients)`,
    );
  });

  socket.on("error", (error) => {
    console.error(
      `[WSS] Socket error (${eventKey}):`,
      error,
    );

    clients.delete(client);
  });
}

export async function broadcastTBAEvent(
  eventKey: string,
  messageType?: string,
) {
  if (!eventKey) {
    return;
  }

  const event: TBAWebSocketEvent = {
    type: "tba-update",
    eventKey,
    messageType,
  };

  await redis.publish(
    TBA_WEBSOCKET_CHANNEL,
    JSON.stringify(event),
  );

  console.log(
    `[WSS] Broadcast TBA update: ${eventKey}${messageType ? ` (${messageType})` : ""}`,
  );
}