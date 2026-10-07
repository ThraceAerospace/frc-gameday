"use client";

import { useEffect, useRef } from "react";

type Stream = { type?: string; url?: string | null };

type Props = {
  stream: Stream | null;
  reloadKey?: number;
  muted?: boolean;
  volume?: number;
};

type TwitchPlayer = {
  setMuted: (muted: boolean) => void;
  setVolume: (volume: number) => void;
};

declare global {
  interface Window {
    Twitch?: {
      Player: new (
        element: HTMLElement,
        options: Record<string, unknown>,
      ) => TwitchPlayer;
    };
  }
}

function sendYouTubeCommand(
  iframe: HTMLIFrameElement,
  func: string,
  args: unknown[] = [],
) {
  iframe.contentWindow?.postMessage(
    JSON.stringify({
      event: "command",
      func,
      args,
    }),
    "https://www.youtube.com",
  );
}

export default function StreamView({
  stream,
  reloadKey = 0,
  muted = true,
  volume = 100,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const twitchContainerRef = useRef<HTMLDivElement>(null);
  const twitchPlayerRef = useRef<TwitchPlayer | null>(null);

  useEffect(() => {
    if (!stream?.url || stream.type !== "youtube" || !iframeRef.current) return;

    const iframe = iframeRef.current;

    const applyAudio = () => {
      sendYouTubeCommand(iframe, "setVolume", [volume]);
      sendYouTubeCommand(iframe, muted ? "mute" : "unMute");
    };

    iframe.addEventListener("load", applyAudio);
    const timer = window.setTimeout(applyAudio, 500);

    return () => {
      iframe.removeEventListener("load", applyAudio);
      window.clearTimeout(timer);
    };
  }, [stream?.url, reloadKey, muted, volume]);

  useEffect(() => {
    if (!stream?.url || stream.type !== "twitch" || !twitchContainerRef.current) {
      return;
    }

    const container = twitchContainerRef.current;
    container.replaceChildren();

    const initialize = () => {
      if (!window.Twitch?.Player || !twitchContainerRef.current) return;

      const url = new URL(stream.url!, window.location.href);
      const channel =
        url.searchParams.get("channel") ||
        url.pathname.split("/").filter(Boolean).pop();

      if (!channel) return;

      const player = new window.Twitch.Player(container, {
        channel,
        parent: [window.location.hostname],
        autoplay: true,
        muted: true,
        width: "100%",
        height: "100%",
      });

      twitchPlayerRef.current = player;
      player.setVolume(volume / 100);
      player.setMuted(muted);
    };

    const scriptSrc = "https://player.twitch.tv/js/embed/v1.js";
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="' + scriptSrc + '"]',
    );

    if (existing) {
      initialize();
    } else {
      const script = document.createElement("script");
      script.src = scriptSrc;
      script.async = true;
      script.onload = initialize;
      document.head.appendChild(script);
    }

    return () => {
      twitchPlayerRef.current = null;
      container.replaceChildren();
    };
  }, [stream?.url, reloadKey]);

  useEffect(() => {
    if (stream?.type !== "twitch") return;

    twitchPlayerRef.current?.setMuted(muted);
    twitchPlayerRef.current?.setVolume(volume / 100);
  }, [muted, volume, stream?.type]);

  if (!stream?.url) return null;

  if (stream.type === "youtube") {
    const src =
      stream.url +
      (stream.url.includes("?") ? "&" : "?") +
      "enablejsapi=1&autoplay=1&mute=1&origin=" +
      encodeURIComponent(
        typeof window !== "undefined" ? window.location.origin : "",
      );

    return (
      <iframe
        ref={iframeRef}
        key={reloadKey}
        className="h-full w-full border-0 bg-black"
        src={src}
        title="YouTube live stream"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    );
  }

  if (stream.type === "twitch") {
    return <div ref={twitchContainerRef} className="h-full w-full bg-black" />;
  }

  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 text-sm text-neutral-500">
      Unsupported webcast type: {stream.type}
    </div>
  );
}
