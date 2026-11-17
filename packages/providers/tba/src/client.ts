/**
 * Provider-owned TBA HTTP transport.
 *
 * This class owns TBA's base URL and authentication header, while returning
 * the native Response so the calling cache adapter can retain ETags,
 * Cache-Control metadata, 304 behavior, and the unchanged response payload.
 * It has no Redis, Next.js, or runtime-platform dependency.
 */
export interface TBAApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface TBAApiRequestOptions {
  headers?: HeadersInit;
}

export class TBAApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: TBAApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://www.thebluealliance.com/api/v3").replace(/\/+$/, "");
    // Cloudflare's global fetch requires the global object as its receiver.
    // Preserve that receiver when storing the function for later invocation.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  request(endpoint: string, options: TBAApiRequestOptions = {}): Promise<Response> {
    if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
      throw new Error("TBA endpoint must be a provider-relative path");
    }

    const headers = new Headers(options.headers);
    headers.set("X-TBA-Auth-Key", this.apiKey);

    return this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      headers,
      cache: "no-store",
    });
  }
}
