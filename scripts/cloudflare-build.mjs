// `npm run build` 的入口。
//
// Deploy to Cloudflare 建立的 repository 不會自動取得新版本。在 Workers Builds 中，
// 本 script 會先把建置目錄換成官方 main 的最新版本，再執行該版本的 `build:app`；
// 使用者只要在 Cloudflare 重新部署即可更新，GitHub repository 本身不會被修改。
//
// 舊版部署可在 Build command 以 curl 下載本檔執行，因此只能使用 Node 內建模組，
// 並以目前工作目錄作為 repository 根目錄。舊的入口會呼叫新版的 `build:app`，
// 往後的版本必須保留這個 script 名稱。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_URL = "https://github.com/TedLin1993/all-set-tw.git";
const UPSTREAM_BRANCH = "main";
const WRANGLER_CONFIG = "wrangler.toml";
// 告訴前端（scripts/build-info.mjs）此部署如何更新：cloudflare 代表重新部署即取得
// 最新版本，repository 代表由 repository 自己管理版本。舊的入口也會傳入，名稱需保留。
const UPDATE_METHOD_VARIABLE = "TAIWAN_FIN_HUB_UPDATE_METHOD";

// 部署頁可自訂的名稱與 Cloudflare 回填的 ID；換成新版時沿用部署原本的值，
// 避免改連到另一個空的 D1 或 Queue。
const DEPLOYMENT_SETTINGS = new Set([
  ".name",
  "d1_databases.database_name",
  "d1_databases.database_id",
  "queues.producers.queue",
  "queues.consumers.queue",
]);

const SECTION_LINE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const ENTRY_LINE = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

export function shouldUseLatestUpstream(directory, environment = process.env) {
  // Cloudflare 建立的 repository 沒有 .github/workflows。有的話代表官方 repository、
  // fork 或已安裝同步 workflow，由 repository 自己管理版本，照舊建置目前檔案。
  return (
    environment.WORKERS_CI === "1" &&
    !existsSync(join(directory, ".github", "workflows"))
  );
}

// 逐行走訪 TOML；同名 section 重複出現時（例如多個 [[d1_databases]]）只處理第一個。
function visitDeploymentSettings(text, visit) {
  let section = "";
  let firstBlock = true;
  const sections = new Set();
  return text.split("\n").map((line, index) => {
    const header = SECTION_LINE.exec(line);
    if (header) {
      section = header[1];
      firstBlock = !sections.has(section);
      sections.add(section);
      return visit({ line, index, section, firstHeader: firstBlock });
    }
    const entry = ENTRY_LINE.exec(line);
    const setting = entry && `${section}.${entry[1]}`;
    if (!firstBlock || !setting || !DEPLOYMENT_SETTINGS.has(setting)) {
      return visit({ line, index, section });
    }
    return visit({ line, index, section, setting, value: entry[2] });
  });
}

export function readDeploymentSettings(text) {
  const settings = new Map();
  visitDeploymentSettings(text, ({ setting, value }) => {
    if (setting) settings.set(setting, value);
  });
  return settings;
}

export function applyDeploymentSettings(text, settings) {
  const remaining = new Map(settings);
  const headerIndex = new Map();
  const lines = visitDeploymentSettings(
    text,
    ({ line, index, section, firstHeader, setting }) => {
      if (firstHeader) headerIndex.set(section, index);
      if (!setting || !remaining.has(setting)) return line;
      const value = remaining.get(setting);
      remaining.delete(setting);
      return line.replace(/=.*$/, `= ${value}`);
    },
  );

  // 新版沒有的設定（例如 Cloudflare 回填的 database_id）加在該 section 標題之後。
  const insertions = [...remaining]
    .map(([setting, value]) => {
      const section = setting.slice(0, setting.lastIndexOf("."));
      const key = setting.slice(setting.lastIndexOf(".") + 1);
      const at = section ? headerIndex.get(section) : -1;
      return at === undefined ? null : { at, line: `${key} = ${value}` };
    })
    .filter(Boolean)
    .sort((left, right) => right.at - left.at);
  for (const { at, line } of insertions) lines.splice(at + 1, 0, line);
  return lines.join("\n");
}

function git(directory, ...args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

// Deploy to Cloudflare 只建立一個沒有 parent 的 commit；之後有 commit 代表可能改過程式碼。
// 淺層 checkout 會隱藏 parent，因此直接讀取 commit header。
function hasCommitsAfterImport(directory) {
  const header = git(directory, "cat-file", "-p", "HEAD").split("\n\n", 1)[0];
  return /^parent /m.test(header);
}

export function switchToLatestUpstream(directory, upstreamUrl = UPSTREAM_URL) {
  const configPath = join(directory, WRANGLER_CONFIG);
  const settings = existsSync(configPath)
    ? readDeploymentSettings(readFileSync(configPath, "utf8"))
    : new Map();

  git(
    directory,
    "fetch",
    "--quiet",
    "--depth=1",
    "--no-tags",
    upstreamUrl,
    `refs/heads/${UPSTREAM_BRANCH}`,
  );
  // 只改變這次建置的暫存 checkout，不會推送到部署 repository。
  git(directory, "reset", "--quiet", "--hard", "FETCH_HEAD");

  if (settings.size > 0 && existsSync(configPath)) {
    writeFileSync(
      configPath,
      applyDeploymentSettings(readFileSync(configPath, "utf8"), settings),
    );
  }
  return git(directory, "rev-parse", "HEAD");
}

export function main(
  directory = process.cwd(),
  environment = process.env,
  upstreamUrl = UPSTREAM_URL,
) {
  const buildEnvironment = { ...environment };
  const npm = (...args) =>
    execFileSync("npm", args, {
      cwd: directory,
      env: buildEnvironment,
      stdio: "inherit",
    });

  if (shouldUseLatestUpstream(directory, environment)) {
    if (hasCommitsAfterImport(directory)) {
      console.warn(
        "[build] 部署 repository 在首次部署後有新的 commit。沒有 .github/workflows 時一律使用官方最新版本建置，repository 內的程式碼修改不會生效；要自行修改程式碼，請先安裝同步 workflow（docs/005-deployment.md）。",
      );
    }
    console.log(`[build] 取得官方最新版本（${UPSTREAM_BRANCH}）...`);
    const commit = switchToLatestUpstream(directory, upstreamUrl);
    console.log(`[build] 使用官方版本 ${commit.slice(0, 12)} 建置。`);
    npm("ci");
    buildEnvironment[UPDATE_METHOD_VARIABLE] = "cloudflare";
  } else if (environment.WORKERS_CI === "1") {
    console.log("[build] repository 含 .github/workflows，使用目前檔案建置。");
    buildEnvironment[UPDATE_METHOD_VARIABLE] = "repository";
  }

  const { scripts = {} } = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  // 透過 curl 執行、且未切換版本的舊版 repository 沒有 build:app。
  npm("run", scripts["build:app"] ? "build:app" : "build");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
