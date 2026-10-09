import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const UPSTREAM_REPOSITORY = "TedLin1993/all-set-tw";
const UPSTREAM_BRANCH = "main";
const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPOSITORY}.git`;

function git(directory, ...args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function optionalGit(directory, ...args) {
  try {
    return git(directory, ...args);
  } catch {
    return "";
  }
}

function sourceTree(directory, commit) {
  return git(directory, "ls-tree", "-r", "-z", "--full-tree", commit)
    .split("\0")
    .filter(
      (entry) =>
        entry &&
        !entry.slice(entry.indexOf("\t") + 1).startsWith(".github/workflows/"),
    )
    .join("\0");
}

function resolveUpstreamCommit(directory, upstreamUrl) {
  const temporary = mkdtempSync(path.join(tmpdir(), "all-set-build-info-"));
  try {
    git(temporary, "init", "--bare");
    git(
      temporary,
      "fetch",
      "--quiet",
      "--no-tags",
      "--filter=blob:none",
      upstreamUrl,
      `refs/heads/${UPSTREAM_BRANCH}:refs/heads/upstream`,
    );
    const head = git(directory, "rev-parse", "HEAD");
    const upstreamCommits = git(temporary, "rev-list", "upstream").split("\n");
    if (upstreamCommits.includes(head)) return head;

    // 淺層 checkout 會隱藏 parent，直接讀取 commit header 辨識自行新增的 commit。
    const header = git(directory, "cat-file", "-p", "HEAD").split("\n\n", 1)[0];
    if (/^parent /m.test(header)) return "";

    const importedTree = sourceTree(directory, "HEAD");
    for (const commit of upstreamCommits) {
      if (importedTree === sourceTree(temporary, commit)) return commit;
    }
    return "";
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function getBuildInfo(directory, upstreamUrl = UPSTREAM_URL) {
  const origin = optionalGit(directory, "remote", "get-url", "origin");
  const isUpstream =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)TedLin1993\/all-set-tw(?:\.git)?\/?$/i.test(
      origin,
    );
  const recordedMessage = optionalGit(
    directory,
    "show",
    "-s",
    "--format=%B",
    "HEAD",
  );
  let commit = [
    ...recordedMessage.matchAll(
      /^Taiwan-Fin-Hub-Upstream: ([0-9a-f]{40,64})$/gm,
    ),
  ].at(-1)?.[1];

  if (!commit && isUpstream)
    commit = optionalGit(directory, "rev-parse", "HEAD");
  if (!commit && optionalGit(directory, "rev-parse", "HEAD")) {
    try {
      commit = resolveUpstreamCommit(directory, upstreamUrl);
    } catch {
      console.warn(
        "[build] 無法辨識上游版本，關於頁的 Commit 將顯示「未知」。",
      );
    }
  }

  return {
    repository: UPSTREAM_REPOSITORY,
    commit: commit || "未知",
    branch: UPSTREAM_BRANCH,
    builtAt: new Date().toISOString(),
  };
}
