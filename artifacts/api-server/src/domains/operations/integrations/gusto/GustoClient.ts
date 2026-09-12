const GUSTO_API_VERSION = "2026-06-15";
const DEFAULT_TIMEOUT_MS = 10_000;

export type GustoConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  baseUrl: string;
};

export type GustoTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type GustoTokenInfo = {
  scopes: string[];
  resourceType: string | null;
  resourceUuid: string | null;
};

export class GustoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GustoConfigurationError";
  }
}

export class GustoApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GustoApiError";
  }
}

export function loadGustoConfig(): GustoConfig {
  const clientId = process.env.GUSTO_CLIENT_ID;
  const clientSecret = process.env.GUSTO_CLIENT_SECRET;
  const redirectUri = process.env.GUSTO_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GustoConfigurationError(
      "Gusto OAuth is not configured; GUSTO_CLIENT_ID, GUSTO_CLIENT_SECRET, and GUSTO_REDIRECT_URI are required",
    );
  }
  const environment = process.env.GUSTO_ENVIRONMENT ?? "demo";
  if (!["demo", "production"].includes(environment)) {
    throw new GustoConfigurationError("GUSTO_ENVIRONMENT must be demo or production");
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    baseUrl:
      process.env.GUSTO_API_BASE_URL ??
      (environment === "production" ? "https://api.gusto.com" : "https://api.gusto-demo.com"),
  };
}

type FetchLike = typeof fetch;

export class GustoClient {
  constructor(
    private readonly config: GustoConfig,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  buildAuthorizationUrl(state: string): string {
    const url = new URL("/oauth/authorize", this.config.baseUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url.toString();
  }

  exchangeAuthorizationCode(code: string): Promise<GustoTokenSet> {
    return this.tokenRequest({ code, grant_type: "authorization_code" });
  }

  refreshAccessToken(refreshToken: string): Promise<GustoTokenSet> {
    return this.tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  }

  async getTokenInfo(accessToken: string): Promise<GustoTokenInfo> {
    const value = await this.requestJson<{
      scope?: string;
      resource?: { type?: string; uuid?: string } | null;
    }>("/v1/token_info", { method: "GET" }, accessToken, true);
    return {
      scopes: value.scope?.split(/\s+/).filter(Boolean) ?? [],
      resourceType: value.resource?.type ?? null,
      resourceUuid: value.resource?.uuid ?? null,
    };
  }

  request<T>(
    path: string,
    init: RequestInit,
    accessToken: string,
  ): Promise<T> {
    return this.requestJson<T>(path, init, accessToken, init.method === "GET");
  }

  private async tokenRequest(grant: Record<string, string>): Promise<GustoTokenSet> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      ...grant,
    });
    const value = await this.requestJson<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    }>("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!value.access_token || !value.refresh_token || !value.expires_in) {
      throw new GustoApiError("Gusto returned an incomplete token response", null, false);
    }
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresIn: value.expires_in,
    };
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    accessToken?: string,
    retrySafe = false,
  ): Promise<T> {
    const attempts = retrySafe ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const headers = new Headers(init.headers);
        headers.set("accept", "application/json");
        headers.set("X-Gusto-API-Version", GUSTO_API_VERSION);
        if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
        const response = await this.fetcher(new URL(path, this.config.baseUrl), {
          ...init,
          headers,
          signal: controller.signal,
        });
        if (response.ok) return (await response.json()) as T;
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt + 1 < attempts) continue;
        throw new GustoApiError(
          `Gusto request failed with status ${response.status}`,
          response.status,
          retryable,
        );
      } catch (error) {
        if (error instanceof GustoApiError) throw error;
        throw new GustoApiError(
          error instanceof Error && error.name === "AbortError"
            ? "Gusto request timed out"
            : "Gusto request failed",
          null,
          true,
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new GustoApiError("Gusto request failed", null, true);
  }
}