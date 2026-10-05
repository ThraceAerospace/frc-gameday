"use client";

import { useEffect, useRef, useState } from "react";

type WebSocketEvent = {
  type: string;
  eventKey?: string;
  messageType?: string;
};

type WebSocketStatus =
  | "connecting"
  | "connected"
  | "disconnected";

export function useWebSocket(
  eventKey: string,
  onEvent?: (event: WebSocketEvent) => void,
) {
  const [status, setStatus] =
    useState<WebSocketStatus>("disconnected");

  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;

  useEffect(() => {
    if (!eventKey) {
      setStatus("disconnected");
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let cancelled = false;
    let reconnectDelay = 1000;

    const connect = () => {
      if (cancelled) return;

      setStatus("connecting");

      const protocol =
        window.location.protocol === "https:"
          ? "wss:"
          : "ws:";

      const url =
        `${protocol}//${window.location.host}` +
        `/api/ws?event=${encodeURIComponent(eventKey)}`;

      socket = new WebSocket(url);

      socket.addEventListener("open", () => {
        if (cancelled) return;

        reconnectDelay = 1000;
        setStatus("connected");
      });

      socket.addEventListener("message", (message) => {
        try {
          const data = JSON.parse(
            message.data,
          ) as WebSocketEvent;

          if (
            data.eventKey &&
            data.eventKey !== eventKey
          ) {
            return;
          }

          callbackRef.current?.(data);
        } catch (error) {
          console.error(
            "useWebSocket: invalid message",
            error,
          );
        }
      });

      socket.addEventListener("error", () => {
        if (!cancelled) {
          setStatus("disconnected");
        }
      });

      socket.addEventListener("close", () => {
        if (cancelled) return;

        setStatus("disconnected");

        reconnectTimer = window.setTimeout(() => {
          reconnectDelay = Math.min(
            reconnectDelay * 2,
            30_000,
          );

          connect();
        }, reconnectDelay);
      });
    };

    connect();

    return () => {
      cancelled = true;

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }

      socket?.close();
      socket = null;
    };
  }, [eventKey]);

  return {
    connected: status === "connected",
    status,
  };
}