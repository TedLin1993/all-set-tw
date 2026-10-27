import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client 分頁", () => {
  it("依 X-Next-Cursor 取完所有頁並依序合併", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        requested.push(path);
        const second = path.includes("cursor=");
        return new Response(JSON.stringify(second ? [3] : [1, 2]), {
          headers: second
            ? { "X-Has-More": "false" }
            : { "X-Has-More": "true", "X-Next-Cursor": "abc=" },
        });
      }),
    );
    expect(
      await createApiClient().getAllPages<number>("/api/investments"),
    ).toEqual([1, 2, 3]);
    expect(requested).toEqual([
      "/api/investments",
      "/api/investments?cursor=abc%3D",
    ]);
  });
});
