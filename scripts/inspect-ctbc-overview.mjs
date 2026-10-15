// Standalone, local-only research. No Worker/D1 bindings or stored credentials.
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const cardMetadata = process.argv.slice(2).includes("--card-metadata");
const creditCards = process.argv.slice(2).includes("--credit-cards");
const balancesOnly = process.argv.slice(2).includes("--balances-only");
const chooseMonth = process.argv.slice(2).includes("--choose-month");
const chooseCurrency =
  chooseMonth || process.argv.slice(2).includes("--choose-currency");
const foreign =
  balancesOnly || chooseCurrency || process.argv.slice(2).includes("--foreign");
if (
  process.argv
    .slice(2)
    .some(
      (arg) =>
        ![
          "--foreign",
          "--choose-currency",
          "--choose-month",
          "--balances-only",
          "--credit-cards",
          "--card-metadata",
        ].includes(arg),
    ) ||
  (balancesOnly && chooseCurrency) ||
  (creditCards && foreign) ||
  (cardMetadata && (creditCards || foreign))
) {
  process.stderr.write(
    "請單獨使用 --foreign、--choose-currency、--choose-month、--balances-only 、--credit-cards 或 --card-metadata；請勿將銀行憑證放在命令列。\n",
  );
  process.exitCode = 1;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write(
    "請在本機互動終端機執行；不接受管線、參數或環境變數中的銀行憑證。\n",
  );
  process.exitCode = 1;
} else {
  await run();
}

async function run() {
  let directory;
  let prompts;
  const config = { deviceCode: crypto.randomUUID() };
  // Bank client diagnostics are intentionally disabled in this standalone
  // process. Only the already-sanitized structure may be printed below.
  console.log = console.warn = console.error = console.info = () => undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "ctbc-overview-inspect-"));
    const bundle = join(directory, "client.mjs");
    await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../apps/worker/src/sources/ctbc/mobile-api.ts",
            import.meta.url,
          ),
        ),
      ],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
    const { createCtbcConnector, CtbcTwoStageRequiredError } = await import(
      pathToFileURL(bundle).href
    );
    const output = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    prompts = createInterface({
      input: process.stdin,
      output,
      terminal: true,
      historySize: 0,
    });
    const ask = async (label) => {
      process.stdout.write(label);
      const answer = await prompts.question("");
      process.stdout.write("\n");
      return answer;
    };
    process.stdout.write(
      cardMetadata
        ? "只查一次信用卡總覽的卡片對照；不查任何明細或存款、不寫資料庫，僅輸出結構與固定布林狀態。輸入不回顯。\n"
        : creditCards
          ? "只查最新一期 TWD 已結帳帳單、當期 TWD 未出帳及目前即時授權，含必要唯讀分頁；不查存款、不寫資料庫、不輸出原始值。輸入不回顯。\n"
          : balancesOnly
            ? "只查所有外幣活存帳戶幣別的目前餘額；不查交易或信用卡、不寫資料庫、不輸出帳號、金額或持有幣別。輸入不回顯。\n"
            : chooseMonth
              ? "只查本機指定的一個幣別帳戶、單一月份明細；不列出持有幣別、不查其他月份、不寫資料庫。輸入不回顯。\n"
              : chooseCurrency
                ? "只查本機指定的一個幣別帳戶本月份明細；不列出持有幣別、不查其他月份、不寫資料庫。輸入不回顯。\n"
                : foreign
                  ? "檢查既有總覽；缺少外幣才查官方外幣總覽，最多查第一幣別本月份明細。不查信用卡、不寫資料庫；輸入不回顯。\n"
                  : "只檢查既有存款總覽；不查交易或信用卡，不寫資料庫。輸入內容全程不回顯。\n",
    );
    let currency;
    let month;
    if (chooseCurrency) {
      currency = (
        await ask("請輸入本次確認範圍的外幣三碼代號（僅留本機記憶體）：")
      )
        .trim()
        .toUpperCase();
      if (
        !/^[A-Z]{3}$/.test(currency) ||
        ["TWD", "NTD", "NAN"].includes(currency)
      ) {
        process.stderr.write("幣別代號格式不符，未登入或送出銀行查詢。\n");
        process.exitCode = 1;
        return;
      }
    }
    if (chooseMonth) {
      month = (await ask("請輸入本次確認範圍的單一月份 YYYY-MM：")).trim();
      const currentMonth = new Date(Date.now() + 8 * 3600_000)
        .toISOString()
        .slice(0, 7);
      if (
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
        month < "2000-01" ||
        month > currentMonth
      ) {
        process.stderr.write(
          "月份格式不符或為未來月份，未登入或送出銀行查詢。\n",
        );
        process.exitCode = 1;
        return;
      }
    }
    config.userId = await ask("中信身分證字號：");
    config.account = await ask("中信使用者代號：");
    config.password = await ask("中信網銀密碼：");
    const connector = createCtbcConnector(undefined, {
      allowInteractiveVerification: true,
      onDeviceSeed: async (seed) => {
        config.deviceSeed = seed;
      },
      onPendingSession: async (session) => {
        config.pendingSession = session;
      },
    });
    let report;
    const inspect = (overrides = {}) =>
      cardMetadata
        ? connector.inspectCardMetadata(config, overrides)
        : creditCards
          ? connector.inspectCreditCards(config, overrides)
          : foreign
            ? connector.inspectForeignDeposits(config, overrides, {
                currency,
                month,
                balancesOnly,
              })
            : connector.inspectDepositOverview(config, overrides);
    try {
      report = await inspect();
    } catch (error) {
      if (
        !(error instanceof CtbcTwoStageRequiredError) ||
        error.method !== "app"
      )
        throw error;
      await ask(
        "請自行在中信 App 核准本次登入，完成後按 Enter（不重送登入）：",
      );
      report = await inspect({
        verification: "check",
      });
    }
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.validation === "not_confirmed") {
      process.stderr.write(
        "唯讀查詢或格式尚未確認；只保留去識別結構，未寫入資料庫。\n",
      );
      process.exitCode = 1;
    }
    process.stdout.write(
      "已結束唯讀檢查並嘗試登出。[*] 是未識別欄位，不能據此判定資料不存在。\n",
    );
  } catch {
    process.stderr.write(
      "本機檢查未完成，未保存銀行回應或憑證；請檢查網路及 App 核准狀態。不輸出銀行錯誤內容。\n",
    );
    process.exitCode = 1;
  } finally {
    prompts?.close();
    for (const key of Object.keys(config)) delete config[key];
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
