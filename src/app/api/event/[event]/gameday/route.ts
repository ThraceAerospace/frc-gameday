export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { TBA } from "@/lib/tbaService";

// simple in-memory cache (swap for Redis later if needed)
const cache = new Map<string, { timestamp: number; data: any }>();

const CACHE_TTL = 30_000; // 30 seconds

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ event: string }> }
) {
  const { event } = await params;

  const { searchParams } = new URL(req.url);
  const team = searchParams.get("team"); // optional

  const cacheKey = `gameday:${event}:${team ?? "all"}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    /**
     * 1. Load event core data
     */
    const eventData: any = await TBA.getEvent(event);
    const teamsAtEvent = await TBA.getTeamsAtEvent(event);
    const playoffAlliances = await TBA.getEventPlayoffAlliances(event) || [];

    if (!eventData) {
      return NextResponse.json(
        { error: "event_not_found", event },
        { status: 404 }
      );
    }

    /**
     * 2. Load matches
     */
    const matchesRaw = await TBA.getEventMatchesSimple(event);

    const now = Math.floor(Date.now() / 1000);

    const matches = ((matchesRaw as any[]) || [])
      .slice()
      .sort((a, b) => a.predicted_time - b.predicted_time)
      .map((m) => {
        const isTeamMatch = team
          ? m.alliances.red.team_keys.includes(`${team}`) ||
            m.alliances.blue.team_keys.includes(`${team}`)
          : false;

        return {
          ...m,
          isTeamMatch,
        };
      });

    const futureMatches = matches.filter(
      (m) => m.predicted_time > now
    );

    /**
     * 3. Team status (optional but useful for next/last match)
     */
    let status: any = null;
    if (team) {
      status = await TBA.getTeamEventStatus(team, event);
    }

    /**
     * 4. Resolve next / last match
     */
    const nextMatch =
      matches.find((m) => m.key === status?.next_match_key) ||
      null;

    const lastMatch =
      matches.find((m) => m.key === status?.last_match_key) ||
      null;

/**
 * 5. Streams normalization
 */
const sortedWebcasts = (eventData.webcasts as Array<any> || [])
  .slice()
  .sort((a, b) => {
    const aTime = a.date ? new Date(a.date).getTime() : 0;
    const bTime = b.date ? new Date(b.date).getTime() : 0;

    return aTime - bTime;
  })

const streams = await Promise.all(
  sortedWebcasts.map(async (wc: any) => {
    if (wc.type === "twitch") {
      return {
        type: "twitch",
        channel: wc.channel,
        url: `https://player.twitch.tv/?autoplay=true&channel=${wc.channel}&parent=${process.env.NEXT_PUBLIC_DOMAIN}`,
        chat: `https://www.twitch.tv/embed/${wc.channel}/chat?parent=${process.env.NEXT_PUBLIC_DOMAIN}`,
        date: wc.date,
        meta: null,
      };
    }

    let meta = null;

    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${wc.channel}&format=json`
      );

      if (res.ok) {
        meta = await res.json();
      }
    } catch {
      meta = null;
    }

    return {
      type: "youtube",
      channel: wc.channel,
      url: `https://www.youtube.com/embed/${wc.channel}?autoplay=1`,
      chat: `https://www.youtube.com/live_chat?v=${wc.channel}`,
      date: wc.date,
      meta,
    };
  })
);

    /**
     * 6. Team match keys (for UI strip highlighting)
     */
    const teamMatchKeys = team
      ? matches
          .filter((m) => m.isTeamMatch)
          .map((m) => m.key)
      : [];

    /**
     * 7. Final response
     */
    const response = {
      event: eventData,
      team: team
        ? {
            key: team,
            status: status
          }
        : null,
      nextMatch,
      lastMatch,
      teams: teamsAtEvent,
      matches,
      streams,
      playoffAlliances,
      teamView: team
        ? {
            enabled: true,
            teamMatchKeys,
          }
        : {
            enabled: false,
            teamMatchKeys: [],
          },

      meta: {
        generatedAt: Date.now(),
        mode: team ? "team-filtered" : "event",
      },
    };

    cache.set(cacheKey, {
      timestamp: Date.now(),
      data: response,
    });

    return NextResponse.json(response);
  } catch (err: any) {
    return NextResponse.json(
      {
        error: "gameday_failed",
        message: String(err?.message ?? err),
      },
      { status: 500 }
    );
  }
}