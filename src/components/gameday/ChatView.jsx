"use client";

export default function ChatView({ stream }) {
  // console.log(stream)
  if (!stream) return null;

  return (
    <iframe
      className="w-full h-full bg-black"
      src={stream.chat}
    />
  );
}