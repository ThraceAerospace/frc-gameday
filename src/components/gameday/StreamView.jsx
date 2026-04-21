"use client";

export default function StreamView({ stream }) {
  if (!stream?.url) {
    return (
      <div className="text-white p-4">
        No stream available
      </div>
    );
  }

  // HARD SAFETY: prevent broken embeds
  // if (!stream.url.includes("embed")) {
  //   return (
  //     <div className="text-red-400 p-4">
  //       Invalid stream URL: {stream.url}
  //     </div>
  //   );
  // }

  return (
    <iframe
      src={stream.url}
      className="w-full h-full"
      allow="autoplay; fullscreen"
      allowFullScreen
    />
  );
}