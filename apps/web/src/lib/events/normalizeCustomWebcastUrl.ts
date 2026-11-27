const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function getVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  let candidate: string | null = null;

  if (host === "youtu.be") {
    candidate = segments[0] ?? null;
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") candidate = url.searchParams.get("v");
    else if (["live", "shorts", "embed"].includes(segments[0] ?? "")) {
      candidate = segments[1] ?? null;
    }
  }

  return candidate && YOUTUBE_VIDEO_ID.test(candidate) ? candidate : null;
}

/**
 * Convert recognized YouTube watch/share/live/short URLs to an embeddable URL.
 * Unknown providers and unrecognized YouTube URLs remain unchanged.
 */
export function normalizeCustomWebcastUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^www\\./, "");
  const isYoutubeHost = host === "youtu.be" || host === "youtube.com" ||
    host === "m.youtube.com" || host === "music.youtube.com";
  if (!isYoutubeHost || url.pathname.startsWith("/embed/")) return url.toString();

  const videoId = getVideoId(url);
  if (!videoId) return url.toString();

  const embed = new URL(`https://www.youtube.com/embed/${videoId}`);
  const start = url.searchParams.get("start");
  if (start && /^\\d+$/.test(start)) embed.searchParams.set("start", start);
  return embed.toString();
}
