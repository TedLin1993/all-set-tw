import { describe, expect, it } from "vitest";
import { cloudflareUpdateTarget } from "./release-update";

const build = {
  builtAt: "2025-01-01T00:00:00Z",
  cloudflareWorkerName: "example-worker",
  cloudflareBuildId: "example-build",
};
const expiresAt = Date.parse("2025-04-01T00:00:00Z");
const history =
  "https://dash.cloudflare.com/?to=/:account/workers/services/view/example-worker/production/builds";

describe("Cloudflare 更新入口", () => {
  it("自訂網域也能開啟本次建置，滿 90 天時改開建置歷史", () => {
    expect(cloudflareUpdateTarget("example.org", build, expiresAt - 1)).toEqual(
      {
        page: "details",
        url: `${history}/example-build`,
      },
    );
    expect(cloudflareUpdateTarget("example.org", build, expiresAt)).toEqual({
      page: "history",
      url: history,
    });
  });

  it("缺少建置識別資訊時，依網址開啟 Worker 歷史或 Workers 列表", () => {
    const missing = {
      ...build,
      cloudflareBuildId: null,
      cloudflareWorkerName: null,
    };
    expect(
      cloudflareUpdateTarget("example-worker.test.workers.dev", missing),
    ).toEqual({
      page: "history",
      url: history,
    });
    expect(cloudflareUpdateTarget("example.org", missing)).toEqual({
      page: "workers",
      url: "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
    });
  });
});
