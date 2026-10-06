"use client";

type Stream = { type?: string; url?: string | null };

type Props = {
  stream: Stream | null;
  reloadKey?: number;
};

export default function StreamView({ stream, reloadKey = 0 }: Props) {
  if (!stream?.url) return null;

  if (stream.type === "youtube") {
    return (
      <iframe
        key={reloadKey}
        className="h-full w-full border-0 bg-black"
        src={stream.url}
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
