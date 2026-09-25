import type { TBAWebcast } from "@/lib/tba/types";

export type BuiltStream = { type: "twitch" | "youtube"; channel: string; url: string; chat: string; date?: string | null; meta: { title?: string | null } | null };

export async function buildStreams(webcasts: TBAWebcast[] = []): Promise<BuiltStream[]> {
  const sortedWebcasts = [...(webcasts || [])].sort((a, b) => {
    const aTime = a.date ? new Date(a.date).getTime() : 0;
    const bTime = b.date ? new Date(b.date).getTime() : 0;
    return aTime - bTime;
  });

  return Promise.all(
    sortedWebcasts.map(async (wc) => {
      if (wc.type === "twitch") {
        return {
          type: "twitch",
          channel: wc.channel,
          url: `https://player.twitch.tv/?autoplay=true&channel=${wc.channel}&parent=${process.env.NEXT_PUBLIC_DOMAIN || "localhost"}`,
          chat: `https://www.twitch.tv/embed/${wc.channel}/chat?parent=${process.env.NEXT_PUBLIC_DOMAIN || "localhost"}`,
          date: wc.date,
          meta: null,
        };
      }

      let meta = null;

      try {
        const res = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${wc.channel}&format=json`
        );

        if (res.ok) meta = (await res.json()) as { title?: string | null };
      } catch {
        meta = null;
      }

      return {
        type: "youtube",
        channel: wc.channel,
        url: `https://www.youtube.com/embed/${wc.channel}?autoplay=1`,
        chat: `https://www.youtube.com/live_chat?v=${wc.channel}&embed_domain=${process.env.NEXT_PUBLIC_DOMAIN || window.location.hostname || "localhost"}`,
        date: wc.date,
        meta,
      };
    })
  );
}