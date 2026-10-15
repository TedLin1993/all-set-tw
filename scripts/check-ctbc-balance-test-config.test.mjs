import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBalanceTestConfig } from "./check-ctbc-balance-test-config.mjs";
const template = JSON.parse(
  await readFile(
    new URL("../wrangler.ctbc-balance-test.json.example", import.meta.url),
    "utf8",
  ),
);
test("模板僅允許本機 dry-run，不能作遠端部署設定", () => {
  assert.equal(
    validateBalanceTestConfig(template, { allowPlaceholder: true }),
    true,
  );
  assert.throws(() => validateBalanceTestConfig(template));
});
for (const [label, change] of [
  [
    "正式 Worker",
    (c) => {
      c.name = "all-set-tw";
    },
  ],
  [
    "正式入口",
    (c) => {
      c.main = "apps/worker/src/index.ts";
    },
  ],
  [
    "正式 DB 名稱",
    (c) => {
      c.d1_databases[0].database_name = "taiwan-fin-hub";
    },
  ],
  [
    "正式 Queue",
    (c) => {
      c.queues.consumers[0].queue = "taiwan-fin-hub-sync";
    },
  ],
  [
    "排程",
    (c) => {
      c.triggers.crons = ["*/10 * * * *"];
    },
  ],
  [
    "路由",
    (c) => {
      c.routes = ["example.invalid/*"];
    },
  ],
  [
    "日誌",
    (c) => {
      c.observability.enabled = true;
    },
  ],
  [
    "關閉驗證",
    (c) => {
      c.vars = { DEMO_MODE: "true" };
    },
  ],
])
  test(`拒絕${label}`, () => {
    const config = structuredClone(template);
    change(config);
    assert.throws(() =>
      validateBalanceTestConfig(config, { allowPlaceholder: true }),
    );
  });
