const DEFAULT_BASE_URL = "https://api.frc-colors.com/v1";

export interface FRCColorsApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Stateless FRC Colors HTTP transport.
 *
 * Provider payloads are returned as native Responses without parsing,
 * normalization, caching, or application-level interpretation. Those
 * responsibilities belong to the runtime/domain boundary.
 */
export class FRCColorsApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: FRCColorsApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  request(endpoint: string, init: RequestInit = {}): Promise<Response> {
    if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
      throw new Error("FRC Colors endpoint must be a provider-relative path");
    }
    return this.fetchImpl(this.baseUrl + endpoint, {
      ...init,
      cache: "no-store",
    });
  }
}
