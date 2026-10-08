import type { WebSocket } from "ws";
import { redis } from "@/lib/cache/redis";

const CHANNEL_PREFIX = "gameday:remote:signal:";
const PRESENCE_PREFIX = "gameday:remote:presence:";
const PRESENCE_TTL_SECONDS = 120;

type RemoteRole = "controller" | "display";

type SignalMessage =
  | { type: "signal"; target: RemoteRole; payload: unknown }
  | { type: "peer-ready"; target: RemoteRole };

function channel(code: string) {
  return `${CHANNEL_PREFIX}${code}`;
}

function presenceKey(code: string, role: RemoteRole) {
  return `${PRESENCE_PREFIX}${code}:${role}`;
}

function validCode(code: string) {
  return /^\d{6}$/.test(code);
}

function validRole(role: string): role is RemoteRole {
  return role === "controller" || role === "display";
}

export function registerRemoteWebSocket(
  socket: WebSocket,
  code: string,
  role: RemoteRole,
  token: string,
) {
  if (!validCode(code) || !validRole(role) || !token) {
    socket.close(1008, "Invalid remote session");
    return;
  }

  void start();

  async function start() {
    const key = presenceKey(code, role);
    const otherRole: RemoteRole =
      role === "controller" ? "display" : "controller";

    const acquired = await redis.set(
      key,
      token,
      "EX",
      PRESENCE_TTL_SECONDS,
      "NX",
    );

    if (acquired !== "OK") {
      socket.send(
        JSON.stringify({
          type: "error",
          message: `A ${role} is already using this code.`,
        }),
      );
      socket.close(1008, "Role already connected");
      return;
    }

    const subscriber = redis.duplicate();
    let closed = false;

    const cleanup = async () => {
      if (closed) return;

      closed = true;
      clearInterval(refreshTimer);

      try {
        await subscriber.unsubscribe(channel(code));
      } catch {}

      subscriber.disconnect();

      try {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token,
        );
      } catch (error) {
        console.error("[Remote] Presence cleanup failed:", error);
      }
    };

    const refreshTimer = setInterval(() => {
      void redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end",
          1,
          key,
          token,
          String(PRESENCE_TTL_SECONDS),
        )
        .catch((error) => {
          console.error("[Remote] Presence refresh failed:", error);
        });
    }, 30_000);

    subscriber.on("error", (error) => {
      console.error("[Remote] Redis subscriber error:", error);
    });

    await subscriber.subscribe(channel(code));

    subscriber.on("message", (topic, message) => {
      if (topic !== channel(code) || closed) return;

      try {
        const parsed = JSON.parse(message) as SignalMessage;

        if (
          parsed.type === "signal" &&
          parsed.target === role
        ) {
          socket.send(
            JSON.stringify({
              type: "signal",
              payload: parsed.payload,
            }),
          );
        }

        if (
          parsed.type === "peer-ready" &&
          parsed.target === role
        ) {
          socket.send(
            JSON.stringify({
              type: "peer-ready",
            }),
          );
        }
      } catch (error) {
        console.error("[Remote] Invalid signaling message:", error);
      }
    });

    socket.send(
      JSON.stringify({
        type: "connected",
        role,
      }),
    );

    if (await redis.exists(presenceKey(code, otherRole))) {
      socket.send(JSON.stringify({ type: "peer-ready" }));
    }

    await redis.publish(
      channel(code),
      JSON.stringify({
        type: "peer-ready",
        target: otherRole,
      } satisfies SignalMessage),
    );

    socket.on("message", (data) => {
      if (closed) return;

      try {
        const message = JSON.parse(
          data.toString(),
        ) as SignalMessage;

        if (
          message.type !== "signal" ||
          !validRole(message.target) ||
          message.target === role
        ) {
          return;
        }

        void redis.publish(
          channel(code),
          JSON.stringify(message),
        );
      } catch (error) {
        console.error("[Remote] Invalid signaling input:", error);
      }
    });

    socket.on("close", () => {
      void cleanup();
    });

    socket.on("error", (error) => {
      console.error("[Remote] Socket error:", error);
      void cleanup();
    });
  }
}
