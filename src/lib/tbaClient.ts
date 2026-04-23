const BASE_URL = "https://www.thebluealliance.com/api/v3";

const etagCache = new Map<string, string>();
const memoryCache = new Map<string, any>();

export class TBAClient {
  constructor(private authKey: string) {
    if (!authKey) throw new Error("Missing TBA API key");
  }

  async get(endpoint: string, revalidate = 3600) {
    const etag = etagCache.get(endpoint);

    const res = await fetch(`${BASE_URL}${endpoint}`, {
      headers: {
        "X-TBA-Auth-Key": this.authKey,
        ...(etag ? { "If-None-Match": etag } : {}),
      },
      next: { revalidate },
    });

    //304  return cached JSON
    if (res.status === 304) {
      const cached = memoryCache.get(endpoint);
      console.log(`[TBA Client] Returning Cached Response for ${endpoint}`)
      return cached
    }

    if (!res.ok) {
      throw new Error(`TBA ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();

    const newEtag = res.headers.get("etag");
    if (newEtag) {
      console.log(`[TBA Client] New ETag set for cache ${endpoint}`)
      etagCache.set(endpoint, newEtag);
      memoryCache.set(endpoint, data);
    }

    return data;
  }
}