"use client";

export default function StreamView({ stream }) {
  if (!stream?.url) {
    return (
      <div className="text-white p-4">
        No stream available
      </div>
    );
  }

  switch (stream.type) {
    case 'youtube':
      return <YouTubeEmbed channel={stream.channel} />;
    case 'twitch':
      return <TwitchEmbed channel={stream.channel} />;
    default:
      return <UnsupportedEmbed type={stream.type} />;
  }
}

function YouTubeEmbed({ channel }) {
  const src = `https://www.youtube.com/embed/${channel}?autoplay=1&mute=1`;
  return (
    <iframe
      className="h-full w-full"
      src={src}
      title="YouTube video player"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
    />
  );
}

function TwitchEmbed({ channel }) {
  // Need to use the current hostname for Twitch's parent parameter
  const hostname =
    typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const src = `https://player.twitch.tv/?channel=${channel}&parent=${hostname}&muted=true`;
  return (
    <iframe
      className="h-full w-full"
      src={src}
      title="Twitch stream"
      allowFullScreen
    />
  );
}

function UnsupportedEmbed({ type }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center
        bg-slate-800 text-white"
    >
      <p className="text-lg">
        Webcast type &quot;{type}&quot; is not supported
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Only YouTube and Twitch webcasts are supported
      </p>
    </div>
  );
}
