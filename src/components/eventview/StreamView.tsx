"use client";

type Stream = { type?: string; url?: string | null };

type Props = {
  muted?: boolean;
  volume?: number;
  stream: Stream | null;
  reloadKey?: number;
};

export default function StreamView({ stream, reloadKey = 0, muted = true, volume = 100 }: Props) {
  if (!stream?.url) return null;

  // Provider APIs can be layered onto the existing iframe embeds. YouTube uses
  // enablejsapi; Twitch requires its official player embed API for audio control.

  if (stream.type === "youtube") {
    return (
      <iframe
        key={reloadKey}
        className="h-full w-full border-0 bg-black"
        src={stream.url + (stream.url.includes("?") ? "&" : "?") + "enablejsapi=1&autoplay=1&mute=1"}
        title="YouTube live stream"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    );
  }

  if (stream.type === "twitch") {
    return (
      <iframe
        key={reloadKey}
        className="h-full w-full border-0 bg-black"
        src={stream.url}
        title="Twitch live stream"
        allow="autoplay; fullscreen"
        allowFullScreen
      />
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 text-sm text-neutral-500">
      Unsupported webcast type: {stream.type}
    </div>
  );
}
