import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./sync-upstream.mjs", import.meta.url),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }

  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).stdout.trim();
}

function write(repo, relativePath, contents) {
  const target = path.join(repo, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function configureAuthor(repo) {
  git(repo, "config", "user.name", "sync-upstream-test");
  git(repo, "config", "user.email", "sync-upstream-test@example.com");
}

function commitAll(repo, message) {
  git(repo, "add", "--all");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function initializeRepository(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  configureAuthor(repo);
}

function initializeBareRepository(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--bare", "--initial-branch=main");
}

function pushMain(worktree, bareRepository) {
  git(worktree, "remote", "add", "origin", bareRepository);
  git(worktree, "push", "-u", "origin", "main");
}

function cloneRepository(bareRepository, destination) {
  run("git", ["clone", bareRepository, destination]);
  configureAuthor(destination);
}

function createUpstream(root, { includeSecondCommit = true } = {}) {
  const worktree = path.join(root, "upstream-worktree");
  const bare = path.join(root, "upstream.git");
  initializeRepository(worktree);
  write(worktree, "app.txt", "version 1\n");
  write(worktree, "removed-after-v1.txt", "remove me\n");
  write(worktree, ".github/workflows/sync-upstream.yml", "name: upstream v1\n");
  write(worktree, ".github/workflows/ci.yml", "name: upstream ci\n");
  const firstCommit = commitAll(worktree, "upstream v1");
  initializeBareRepository(bare);
  pushMain(worktree, bare);

  let latestCommit = firstCommit;
  if (includeSecondCommit) {
    write(worktree, "app.txt", "version 2\n");
    write(worktree, "new-in-v2.txt", "new\n");
    rmSync(path.join(worktree, "removed-after-v1.txt"));
    latestCommit = commitAll(worktree, "upstream v2");
    git(worktree, "push", "origin", "main");
  }

  return { bare, firstCommit, latestCommit, worktree };
}

function createImportedDeployment(root, upstream, options = {}) {
  const worktree = path.join(root, "deployment-worktree");
  const bare = path.join(root, "deployment.git");
  initializeRepository(worktree);

  if (options.unknownBaseline) {
    write(worktree, "app.txt", "not an upstream version\n");
  } else {
    write(worktree, "app.txt", "version 1\n");
    write(worktree, "removed-after-v1.txt", "remove me\n");
  }
  const rootCommit = commitAll(worktree, "Cloudflare source repo import");

  write(
    worktree,
    ".github/workflows/sync-upstream.yml",
    "name: manually installed updater\n",
  );
  const beforeSync = commitAll(worktree, "install updater workflow");

  if (options.userChange) {
    write(worktree, "user-change.txt", "keep me\n");
    commitAll(worktree, "user customization");
  }

  initializeBareRepository(bare);
  pushMain(worktree, bare);
  git(worktree, "remote", "add", "test-upstream", upstream.bare);

  return { bare, beforeSync, rootCommit, worktree };
}

function runUpdater(worktree, upstreamBare) {
  return run(process.execPath, [scriptPath], {
    cwd: worktree,
    allowFailure: true,
    env: {
      ...process.env,
      SYNC_UPSTREAM_URL: upstreamBare,
    },
  });
}

function remoteBranch(worktree, branch) {
  return git(
    worktree,
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ).split("\t")[0];
}

function withTemporaryRepository(testFunction) {
  const root = mkdtempSync(path.join(tmpdir(), "taiwan-fin-hub-sync-test-"));
  try {
    testFunction(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("最新版保持 no-op，不建立備份 branch", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const originBare = path.join(root, "deployment.git");
    initializeBareRepository(originBare);
    git(upstream.worktree, "remote", "add", "deployment", originBare);
    git(upstream.worktree, "push", "deployment", "main");

    const runner = path.join(root, "runner");
    cloneRepository(originBare, runner);
    const before = git(runner, "rev-parse", "HEAD");
    const result = runUpdater(runner, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(runner, "rev-parse", "HEAD"), before);
    assert.equal(remoteBranch(runner, "backup-before-first-upstream-sync"), "");
    assert.match(result.stdout, /目前已是最新版/);
  });
});

test("有共同祖先且落後時建立單一 parent 的三方同步 commit", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });
    const originBare = path.join(root, "deployment.git");
    initializeBareRepository(originBare);
    git(upstream.worktree, "remote", "add", "deployment", originBare);
    git(upstream.worktree, "push", "deployment", "main");

    write(upstream.worktree, "app.txt", "version 2\n");
    upstream.latestCommit = commitAll(upstream.worktree, "upstream v2");
    git(upstream.worktree, "push", "origin", "main");

    const runner = path.join(root, "runner");
    cloneRepository(originBare, runner);
    write(
      runner,
      ".github/workflows/sync-upstream.yml",
      "name: deployment updater\n",
    );
    commitAll(runner, "keep deployment updater");
    git(runner, "push", "origin", "main");
    const result = runUpdater(runner, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(runner, "show", "HEAD:.github/workflows/sync-upstream.yml"),
      "name: deployment updater",
    );
    assert.equal(
      git(
        runner,
        "diff",
        "--name-only",
        "HEAD",
        "upstream/main",
        "--",
        ".",
        ":(exclude).github/workflows/**",
      ),
      "",
    );
    assert.equal(
      git(runner, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length,
      2,
    );
    assert.match(
      git(runner, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstream.latestCommit}`),
    );
    assert.equal(remoteBranch(runner, "backup-before-first-upstream-sync"), "");
    assert.match(result.stdout, /作為三方合併基準/);
  });
});

test("首次無共同祖先時驗證來源、建立備份並同步完整上游 tree", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      remoteBranch(deployment.worktree, "backup-before-first-upstream-sync"),
      deployment.beforeSync,
    );
    assert.equal(
      git(
        deployment.worktree,
        "diff",
        "--name-only",
        "HEAD",
        "upstream/main",
        "--",
        ".",
        ":(exclude).github/workflows/**",
      ),
      "",
    );
    assert.equal(
      git(
        deployment.worktree,
        "show",
        "HEAD:.github/workflows/sync-upstream.yml",
      ),
      "name: manually installed updater",
    );
    assert.equal(
      git(deployment.worktree, "ls-files", ".github/workflows/ci.yml"),
      "",
    );
    assert.equal(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" ").length,
      2,
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstream.latestCommit}`),
    );
    assert.notEqual(
      run(
        "git",
        ["merge-base", "--is-ancestor", upstream.latestCommit, "HEAD"],
        { cwd: deployment.worktree, allowFailure: true },
      ).status,
      0,
    );
    assert.equal(
      git(deployment.worktree, "ls-files", "removed-after-v1.txt"),
      "",
    );
  });
});

test("首次版本已是最新時仍以 allow-empty commit 記錄上游 baseline", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });
    const deployment = createImportedDeployment(root, upstream);
    const before = git(deployment.worktree, "rev-parse", "HEAD");
    const beforeTree = git(deployment.worktree, "rev-parse", "HEAD^{tree}");

    const result = runUpdater(deployment.worktree, upstream.bare);
    const after = git(deployment.worktree, "rev-parse", "HEAD");

    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(after, before);
    assert.equal(
      git(deployment.worktree, "rev-parse", "HEAD^{tree}"),
      beforeTree,
    );
    assert.deepEqual(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" "),
      [after, before],
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstream.latestCommit}`),
    );
  });
});

test("首次同步會拒絕 workflows 以外的使用者修改且不 push", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream, {
      userChange: true,
    });
    const before = remoteBranch(deployment.worktree, "main");
    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /已有 \.github\/workflows 以外的程式碼變更/);
    assert.match(result.stderr, /user-change\.txt/);
    assert.equal(remoteBranch(deployment.worktree, "main"), before);
    assert.equal(
      remoteBranch(deployment.worktree, "backup-before-first-upstream-sync"),
      "",
    );
  });
});

test("找不到相符上游基準時拒絕首次同步", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream, {
      unknownBaseline: true,
    });
    const before = remoteBranch(deployment.worktree, "main");
    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /無法對應任何上游版本/);
    assert.equal(remoteBranch(deployment.worktree, "main"), before);
    assert.equal(
      remoteBranch(deployment.worktree, "backup-before-first-upstream-sync"),
      "",
    );
  });
});

test("既有首次同步備份 branch 不會被覆寫", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    git(
      deployment.worktree,
      "push",
      "origin",
      `${deployment.rootCommit}:refs/heads/backup-before-first-upstream-sync`,
    );

    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      remoteBranch(deployment.worktree, "backup-before-first-upstream-sync"),
      deployment.rootCommit,
    );
    assert.match(result.stdout, /為避免覆寫既有備份/);
  });
});

test("首次接軌成功後重跑保持冪等", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const firstResult = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(firstResult.status, 0, firstResult.stderr);
    const afterFirstSync = git(deployment.worktree, "rev-parse", "HEAD");

    const secondResult = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(secondResult.status, 0, secondResult.stderr);
    assert.equal(git(deployment.worktree, "rev-parse", "HEAD"), afterFirstSync);
    assert.equal(remoteBranch(deployment.worktree, "main"), afterFirstSync);
    assert.match(secondResult.stdout, /使用先前同步紀錄/);
    assert.match(secondResult.stdout, /目前已是最新版/);
  });
});

test("三方合併發生程式碼衝突時不改 working tree 且不 push", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });
    const originBare = path.join(root, "deployment.git");
    initializeBareRepository(originBare);
    git(upstream.worktree, "remote", "add", "deployment", originBare);
    git(upstream.worktree, "push", "deployment", "main");

    const runner = path.join(root, "runner");
    cloneRepository(originBare, runner);
    write(runner, "app.txt", "deployment change\n");
    const deploymentCommit = commitAll(runner, "deployment change");
    git(runner, "push", "origin", "main");

    write(upstream.worktree, "app.txt", "upstream change\n");
    commitAll(upstream.worktree, "upstream change");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(runner, upstream.bare);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONFLICT|發生衝突/);
    assert.equal(remoteBranch(runner, "main"), deploymentCommit);
    assert.equal(git(runner, "rev-parse", "HEAD"), deploymentCommit);
    assert.equal(git(runner, "status", "--porcelain"), "");
  });
});

test("先前同步後的非衝突使用者修改會保留，且不引入上游 parent", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const firstResult = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(firstResult.status, 0, firstResult.stderr);

    write(deployment.worktree, "user-note.txt", "deployment note\n");
    const userCommit = commitAll(deployment.worktree, "user note");
    git(deployment.worktree, "push", "origin", "main");

    write(upstream.worktree, "upstream-v3.txt", "upstream v3\n");
    const upstreamV3 = commitAll(upstream.worktree, "upstream v3");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(deployment.worktree, "show", "HEAD:user-note.txt"),
      "deployment note",
    );
    assert.equal(
      git(deployment.worktree, "show", "HEAD:upstream-v3.txt"),
      "upstream v3",
    );
    assert.deepEqual(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" "),
      [git(deployment.worktree, "rev-parse", "HEAD"), userCommit],
    );
    assert.notEqual(
      run("git", ["merge-base", "--is-ancestor", upstreamV3, "HEAD"], {
        cwd: deployment.worktree,
        allowFailure: true,
      }).status,
      0,
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstreamV3}`),
    );
  });
});

test("只有上游 workflow 變更時以 allow-empty commit 更新 baseline", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const firstResult = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(firstResult.status, 0, firstResult.stderr);
    const before = git(deployment.worktree, "rev-parse", "HEAD");
    const beforeTree = git(deployment.worktree, "rev-parse", "HEAD^{tree}");

    write(
      upstream.worktree,
      ".github/workflows/ci.yml",
      "name: upstream ci v2\n",
    );
    const workflowOnlyCommit = commitAll(upstream.worktree, "update workflow");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(deployment.worktree, upstream.bare);
    const after = git(deployment.worktree, "rev-parse", "HEAD");

    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(after, before);
    assert.equal(
      git(deployment.worktree, "rev-parse", "HEAD^{tree}"),
      beforeTree,
    );
    assert.deepEqual(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" "),
      [after, before],
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${workflowOnlyCommit}`),
    );
    assert.match(result.stdout, /保留部署版本/);
  });
});
