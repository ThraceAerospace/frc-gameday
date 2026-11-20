const DEFAULT_BASE_URL = "https://api.statbotics.io";

export interface StatboticsApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** Stateless Statbotics v3 HTTP transport. Cache policy belongs to the runtime adapter. */
export class StatboticsApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: StatboticsApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Cloudflare's global fetch requires the global object as its receiver.
    // Preserve that receiver when storing the function for later invocation.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  request(endpoint: string, init: RequestInit = {}): Promise<Response> {
    if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
      throw new Error("Statbotics endpoint must be a provider-relative path");
    }
    return this.fetchImpl(this.baseUrl + "/v3" + endpoint, {
      ...init,
      cache: "no-store",
    });
  }
}
