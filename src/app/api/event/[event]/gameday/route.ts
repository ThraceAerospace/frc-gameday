

import { NextRequest, NextResponse } from "next/server";
import { TBA } from "@/lib/tbaService";

import { normalizeMatches } from "@/lib/gameday/normalizeMatches";
import { getNextMatch } from "@/lib/gameday/getNextMatch";
import { getLastMatch } from "@/lib/gameday/getLastMatch";

const cache = new Map<string, { timestamp: number; data: any }>();
const CACHE_TTL = 30_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ event: string }> }
) {
  const { event } = await params;
  const { searchParams } = new URL(req.url);
  const team = searchParams.get("team");

  const cacheKey = `gameday:${event}:${team ?? "all"}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    /**
     * 1. Fetch core data
     */
    const [eventData, teams, alliances, matchesRaw] = await Promise.all([
      TBA.getEvent(event),
      TBA.getTeamsAtEvent(event),
      TBA.getEventPlayoffAlliances(event).catch(() => []),
      TBA.getEventMatchesSimple(event),
    ]);

    if (!eventData) {
      return NextResponse.json(
        { error: "event_not_found", event },
        { status: 404 }
      );
    }

    /**
     * 2. Normalize matches (NO semantic filtering here)
     */
    const matches = normalizeMatches(matchesRaw, team ?? undefined);

    /**
     * 3. Derived state (OLD SIMPLE MODEL RESTORED)
     */
    const nextMatch = getNextMatch(matches);
    const lastMatch = getLastMatch(matches);

    /**
     * 4. Optional team status
     */
    let status: any = null;
    if (team) {
      status = await TBA.getTeamEventStatus(team, event);
    }

    /**
     * 5. Streams (unchanged)
     */
    const streams = (eventData.webcasts || []).map((wc: any) => ({
      type: wc.type,
      channel: wc.channel,
      date: wc.date,
    }));

    /**
     * 6. Response (clean + minimal derivation)
     */
    const response = {
      event: eventData,
      team: team
        ? {
            key: team,
            status,
          }
        : null,

      matches,
      nextMatch,
      lastMatch,

      teams,
      streams,
      playoffAlliances: alliances,

      meta: {
        generatedAt: Date.now(),
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