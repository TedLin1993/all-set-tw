import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARE_API_BASE,
  findD1DatabaseByName,
  listAuthorizedAccounts,
  runAccountPrecheck,
} from "../../src/platform/cloudflare";
import { hasCloudflareAccessChallenge } from "../../src/platform/cloudflare-provision";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account precheck", () => {
  it("is ready only when subdomain, Access org, and worker name are all free", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/workers/subdomain")) {
          return Response.json({ result: { subdomain: "ok" } });
        }
        if (url.includes("/access/organizations")) {
          return Response.json({
            result: { auth_domain: "team.cloudflareaccess.com" },
          });
        }
        if (url.includes("/workers/scripts/")) {
          return new Response(null, { status: 404 });
        }
        if (url.includes("/d1/database") || url.includes("/queues")) {
          return Response.json({ result: [] });
        }
        return new Response("unexpected " + url, { status: 500 });
      }),
    );
    await expect(
      runAccountPrecheck({
        accessToken: "token",
        accountId: "acct-1",
        workerName: "taiwan-fin-hub",
      }),
    ).resolves.toMatchObject({ ready: true });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain(CLOUDFLARE_API_BASE);
  });
});

describe("Cloudflare list pagination", () => {
  it("reads every memberships page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get("page") ?? "1");
        if (page === 1) {
          return Response.json({
            result: [{ account: { id: "acct-1", name: "One" } }],
            result_info: { page: 1, per_page: 50, total_pages: 2 },
          });
        }
        return Response.json({
          result: [{ account: { id: "acct-2", name: "Two" } }],
          result_info: { page: 2, per_page: 50, total_pages: 2 },
        });
      }),
    );
    await expect(listAuthorizedAccounts("token")).resolves.toEqual([
      { id: "acct-1", name: "One" },
      { id: "acct-2", name: "Two" },
    ]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("finds a D1 database beyond the first page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("name")).toBe("taiwan-fin-hub");
        const page = Number(url.searchParams.get("page") ?? "1");
        if (page === 1) {
          return Response.json({
            result: [{ uuid: "d1-other", name: "other" }],
            result_info: { page: 1, per_page: 50, total_pages: 2 },
          });
        }
        return Response.json({
          result: [{ uuid: "d1-target", name: "taiwan-fin-hub" }],
          result_info: { page: 2, per_page: 50, total_pages: 2 },
        });
      }),
    );
    await expect(
      findD1DatabaseByName("token", "acct-1", "taiwan-fin-hub"),
    ).resolves.toEqual({ id: "d1-target", name: "taiwan-fin-hub" });
  });
});

describe("Access challenge evidence", () => {
  it("accepts an Access login redirect and rejects a bare 403", () => {
    expect(
      hasCloudflareAccessChallenge({
        status: 302,
        location: "https://example.cloudflareaccess.com/cdn-cgi/access/login",
      }),
    ).toBe(true);
    expect(
      hasCloudflareAccessChallenge({
        status: 403,
        location: null,
      }),
    ).toBe(false);
    expect(
      hasCloudflareAccessChallenge({
        status: 401,
        location: null,
        wwwAuthenticate:
          'Bearer realm="https://example.cloudflareaccess.com", resource_metadata="https://example/.well-known/oauth-protected-resource"',
      }),
    ).toBe(true);
  });
});
