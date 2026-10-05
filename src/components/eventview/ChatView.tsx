"use client";

type Stream = { chat?: string | null };
export default function ChatView({ stream }: { stream: Stream | null }) {
  if (!stream?.chat) return <div className="flex h-full items-center justify-center text-xs text-neutral-500">No chat available</div>;
  return <iframe className="h-full w-full border-0 bg-black" src={stream.chat} title="Live chat" />;
}
