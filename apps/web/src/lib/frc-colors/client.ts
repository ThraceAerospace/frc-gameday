import { randomUUID } from "node:crypto";
import { redis } from "@/lib/cache/redis";
import { FRCColorsApiClient } from "@fieldview/provider-frc-colors/client";
import { FRC_COLORS_ENDPOINTS } from "@fieldview/provider-frc-colors/endpoints";
import {
  toLegacyFRCColors,
  type FRCColor,
  type LegacyFRCColorsEventResponse,
} from "./legacy-compatibility";

const provider = new FRCColorsApiClient();

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const LOCK_TTL_SECONDS = 20;
const CACHE_PREFIX = "cache:frc-colors:v1:";
const LOCK_PREFIX = "lock:frc-colors:v1:";

function cacheKey(eventCode: string) {
  return CACHE_PREFIX + encodeURIComponent(eventCode);
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
      const response = await provider.request(FRC_COLORS_ENDPOINTS.event(eventCode));
      if (!response.ok) throw new Error(`FRC Colors event request failed (${response.status})`);
      const payload = await response.json() as LegacyFRCColorsEventResponse;
      const colors = toLegacyFRCColors(payload);
      await redis.set(key, JSON.stringify(colors), "EX", CACHE_TTL_SECONDS);
      return colors;
    } catch (error) {
      if (cached) return cached;
      throw error;
    } finally {
      try {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lock,
          token,
        );
      } catch (error) {
        console.warn("[FRC Colors] failed to release event cache lock", eventCode, error);
      }
    }
  }
}
