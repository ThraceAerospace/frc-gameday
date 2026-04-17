const BASE_URL = "https://www.thebluealliance.com/api/v3";

export class TBAClient {
  constructor(private authKey: string) {
    if (!authKey) throw new Error("Missing TBA API key");
  }

  async get<T>(endpoint: string, revalidate = 3600): Promise<T> {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      cache: "no-store",
      headers: {
        "X-TBA-Auth-Key": this.authKey,
        "Cache-Control": "no-store",
      },
      next: { revalidate: 10 },
    });

    if (!res.ok) {
      throw new Error(`TBA ${res.status}: ${await res.text()}`);
    }

    return res.json();
  }
}