"use client";

type Stream = { type?: string; url?: string | null };

export default function StreamView({ stream }: { stream: Stream | null }) {
  if (!stream?.url) return null;
  if (stream.type === "youtube") return <iframe className="h-full w-full border-0 bg-black" src={stream.url} title="YouTube live stream" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />;
  if (stream.type === "twitch") return <iframe className="h-full w-full border-0 bg-black" src={stream.url} title="Twitch live stream" allowFullScreen />;
  return <div className="flex h-full items-center justify-center bg-neutral-950 text-sm text-neutral-500">Unsupported webcast type: {stream.type}</div>;
}
