import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import process from "node:process";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const chromeExecutable =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profileDirectory = resolve(
  "research/firstbank-web-recording/chrome-profile",
);
const exportDirectory = resolve("research/firstbank-web-recording/exports");
const entryUrl = "https://ibank.firstbank.com.tw/NetBank/index103.html";

async function ensureIgnored(path) {
  try {
    await execFileAsync("git", ["check-ignore", "--quiet", path]);
  } catch {
    throw new Error("recording_directory_not_ignored");
  }
}

async function main() {
  await ensureIgnored(profileDirectory);
  await ensureIgnored(exportDirectory);
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await mkdir(exportDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(exportDirectory, "README.txt"),
    [
      "第一銀行 Chrome DevTools Recorder 本機匯出目錄",
      "",
      "錄製內容可能包含帳號、密碼及驗證碼，請勿上傳、提交或加入 git。",
      "建議匯出格式：JSON（Chrome Recorder）。",
      "完成錄製後請把 JSON 儲存在此目錄，再回到 Codex；不要把內容貼到對話。",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const chrome = spawn(
    chromeExecutable,
    [
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-extensions",
      "--auto-open-devtools-for-tabs",
      entryUrl,
    ],
    { detached: true, stdio: "ignore" },
  );
  chrome.unref();

  process.stdout.write(
    [
      "已開啟第一銀行專用 Chrome 視窗與 DevTools。",
      "在 DevTools 右上角選 More tools > Recorder，建立新 recording 後操作完整流程。",
      `完成後請用 Recorder 的 Export > JSON，儲存到：${exportDirectory}`,
      "不要把 JSON 內容貼到對話；只要告訴 Codex 檔名即可。",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  const code = error instanceof Error ? error.message : "unknown_error";
  process.stderr.write(`無法開啟第一銀行 Recorder：${code}\n`);
  process.exitCode = 1;
});
