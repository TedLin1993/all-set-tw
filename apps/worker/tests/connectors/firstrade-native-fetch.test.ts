import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { describe, expect, it } from "vitest";

describe("connector native Workers fetch", () => {
  it("calls the native fetch with the correct receiver for the firstrade API client", async () => {
    const bundle = await build({
      stdin: {
        contents: `import {FirstradeApiClient} from '../../packages/connectors/src/firstrade-api';

      export default {async fetch() {
        const firstrade = await new FirstradeApiClient().login('synthetic','synthetic');

        return Response.json({firstrade:firstrade.kind});
      }};`,
        resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      write: false,
    });
    const requests: string[] = [];
    let redirectBootstrap = false;
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        compatibilityDate: "2026-06-01",
        script: bundle.outputFiles[0].text,
        outboundService: (request) => {
          const path = new URL(request.url).pathname;
          requests.push(path);
          if (redirectBootstrap)
            return new Response(null, {
              status: 302,
              headers: { Location: "https://redirect.invalid/" },
            });
          if (path === "/") return new Response("ready");
          if (path === "/sess/login")
            return Response.json({
              sid: "synthetic-sid",
              ftat: "synthetic-ftat",
            });
          return Response.json({
            success: true,
            data: {
              uuid: "synthetic-captcha",
              captchaImage: "data:image/png;base64,aGVsbG8=",
            },
          });
        },
      }),
    );
    try {
      const response = await mf.dispatchFetch("http://localhost");
      expect(
        response.status,
        response.status === 200 ? "" : await response.text(),
      ).toBe(200);
      expect(await response.json()).toEqual({
        firstrade: "ready",
      });
      expect(requests).toHaveLength(2);
      redirectBootstrap = true;
      requests.length = 0;
      const redirected = await mf.dispatchFetch("http://localhost");
      expect(redirected.status).toBe(500);
      expect(await redirected.text()).toContain("transport");
      expect(requests).toEqual(["/"]);
    } finally {
      await mf.dispose();
    }
  }, 60000);
});
