// Local validation only. Does not invoke Wrangler, a shell, or Cloudflare APIs.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_WORKER = "all-set-tw-ctbc-balance-test";
export const TEST_DB = `${TEST_WORKER}-db`;
export const TEST_QUEUE = `${TEST_WORKER}-sync`;
export const PLACEHOLDER_DB_ID = "00000000-0000-4000-8000-000000000001";

export function validateBalanceTestConfig(
  config,
  { allowPlaceholder = false } = {},
) {
  const require = (ok) => {
    if (!ok)
      throw new Error("測試部署設定未通過隔離檢查；不要部署或執行遠端遷移。");
  };
  const allowedKeys = new Set([
    "name",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "assets",
    "triggers",
    "queues",
    "d1_databases",
    "secrets",
    "observability",
  ]);
  require(Object.keys(config).every((key) => allowedKeys.has(key)));
  require(config.name === TEST_WORKER);
  require(config.main === "apps/worker/src/ctbc-balance-test-entry.ts");
  require(config.workers_dev === true && config.preview_urls === false);
  require(
    config.assets?.directory === "apps/web/dist" &&
      config.assets?.binding === "ASSETS",
  );
  require(
    !config.routes &&
      !config.route &&
      !config.env &&
      !config.build &&
      !config.vars,
  );
  require(
    !config.browser &&
      !config.ai &&
      !config.services &&
      !config.durable_objects,
  );
  require(config.triggers?.crons?.length === 0);
  require(config.observability?.enabled === false);
  require(config.d1_databases?.length === 1);
  const db = config.d1_databases[0];
  require(
    db.binding === "DB" &&
      db.database_name === TEST_DB &&
      db.migrations_dir === "apps/worker/migrations",
  );
  require(
    typeof db.database_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        db.database_id,
      ),
  );
  require(allowPlaceholder || db.database_id !== PLACEHOLDER_DB_ID);
  require(
    config.queues?.producers?.length === 1 &&
      config.queues?.consumers?.length === 1,
  );
  require(
    config.queues.producers[0].binding === "SYNC_QUEUE" &&
      config.queues.producers[0].queue === TEST_QUEUE,
  );
  require(config.queues.consumers[0].queue === TEST_QUEUE);
  require(
    config.queues.consumers[0].max_batch_size === 1 &&
      config.queues.consumers[0].max_concurrency === 1,
  );
  require(
    ["CONFIG_ENCRYPTION_KEY", "TEAM_DOMAIN", "POLICY_AUD"].every((key) =>
      config.secrets?.required?.includes(key),
    ),
  );
  return true;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3) throw new Error();
    const config = JSON.parse(await readFile(process.argv[2], "utf8"));
    validateBalanceTestConfig(config);
    console.log(
      "本機設定隔離檢查通過；仍須唯讀核對 D1 ID 確實屬於新測試資料庫。",
    );
  } catch {
    console.error(
      "測試設定未通過檢查（含尚未替換的資料庫 ID）；未執行任何雲端操作。",
    );
    process.exitCode = 1;
  }
}
