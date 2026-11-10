import { randomUUID } from "node:crypto";
import { redis } from "@/lib/cache/redis";

const BASE_URL = "https://api.frc-colors.com/v1";
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const LOCK_TTL_SECONDS = 20;
const CACHE_PREFIX = "cache:frc-colors:v1:";
const LOCK_PREFIX = "lock:frc-colors:v1:";

export type FRCColor = {
  teamNumber: number;
  primaryHex: string | null;
  secondaryHex: string | null;
  verified: boolean | null;
};

type EventResponse = {
  teams?: Record<string, {
    teamNumber?: number;
    colors?: {
      primaryHex?: string | null;
      secondaryHex?: string | null;
      verified?: boolean;
    } | null;
  }>;
};

function cacheKey(eventCode: string) {
  return CACHE_PREFIX + encodeURIComponent(eventCode);
}

function validHex(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase()
    : null;
}

function parseCached(raw: string): FRCColor[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as FRCColor[];
  } catch {
    return null;
  }
}

export class FRCColorsClient {
  async getEvent(eventCode: string, options: { refresh?: boolean } = {}): Promise<FRCColor[]> {
    const key = cacheKey(eventCode);
    const raw = await redis.get(key);
    const cached = raw ? parseCached(raw) : null;
    if (raw && !cached) await redis.del(key);
    if (cached && !options.refresh) return cached;

    const lock = LOCK_PREFIX + encodeURIComponent(eventCode);
    const token = randomUUID();
    const acquired = await redis.set(lock, token, "EX", LOCK_TTL_SECONDS, "NX");
    if (acquired !== "OK") {
      if (cached) return cached;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const concurrent = await redis.get(key);
        const parsed = concurrent ? parseCached(concurrent) : null;
        if (parsed) return parsed;
      }
      throw new Error("An FRC Colors request for this event is already in progress");
    }

    try {
      const response = await fetch(
        BASE_URL + "/event/" + encodeURIComponent(eventCode),
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`FRC Colors event request failed (${response.status})`);
      const payload = await response.json() as EventResponse;
      const colors = Object.entries(payload.teams ?? {}).flatMap(([key, team]) => {
        const teamNumber = Number(team.teamNumber ?? key);
        if (!Number.isSafeInteger(teamNumber) || teamNumber <= 0) return [];
        return [{
          teamNumber,
          primaryHex: validHex(team.colors?.primaryHex),
          secondaryHex: validHex(team.colors?.secondaryHex),
          verified: typeof team.colors?.verified === "boolean" ? team.colors.verified : null,
        }];
      });
      await redis.set(key, JSON.stringify(colors), "EX", CACHE_TTL_SECONDS);
      return colors;
    } catch (error) {
      if (cached) return cached;
      throw error;
    } finally {
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lock,
        token,
      );
    }
  }
}
