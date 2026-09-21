import { describe, expect, it } from "vitest";
import {
  DEPLOYER_OAUTH_SCOPES,
  buildAuthorizeUrl,
  createPkceChallenge,
} from "../../src/platform/oauth";

describe("OAuth helpers", () => {
  it("builds an authorization URL with PKCE and the documented scopes", async () => {
    const pkce = await createPkceChallenge();
    const url = new URL(
      buildAuthorizeUrl(
        {
          clientId: "client",
          clientSecret: "secret",
          redirectUri: "http://localhost/api/auth/callback",
        },
        { state: "state-1", challenge: pkce.challenge },
      ),
    );
    expect(url.origin + url.pathname).toBe(
      "https://dash.cloudflare.com/oauth2/authorize",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      ...DEPLOYER_OAUTH_SCOPES,
    ]);
    expect(url.searchParams.get("client_secret")).toBeNull();
  });
});
