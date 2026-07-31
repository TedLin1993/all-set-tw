import assert from "node:assert/strict";
import test from "node:test";
import { ensureQueueExists } from "./deploy-with-vapid.mjs";
import { isWorkersBuild } from "./prepare-cloudflare-build.mjs";

const queueName = "taiwan-fin-hub-sync";
const missingQueue = {
  exitCode: 1,
  stdout: "",
  stderr: `Queue "${queueName}" does not exist.`,
};

test("only prepares resources inside Cloudflare Workers Builds", () => {
  assert.equal(isWorkersBuild({ WORKERS_CI: "1" }), true);
  assert.equal(isWorkersBuild({ WORKERS_CI: undefined }), false);
});

function runner(results, calls) {
  return async (argumentsToRun, options) => {
    calls.push({ argumentsToRun, options });
    const result = results.shift();
    assert.ok(result, "Unexpected Wrangler invocation");
    return result;
  };
}

test("keeps an existing Queue", async () => {
  const calls = [];
  await ensureQueueExists(
    queueName,
    ["--config", "wrangler.toml"],
    runner([{ exitCode: 0, stdout: "Queue Name", stderr: "" }], calls),
  );

  assert.deepEqual(
    calls.map((call) => call.argumentsToRun),
    [["queues", "info", queueName, "--config", "wrangler.toml"]],
  );
});

test("creates a missing Queue", async () => {
  const calls = [];
  await ensureQueueExists(
    queueName,
    [],
    runner(
      [missingQueue, { exitCode: 0, stdout: "Created", stderr: "" }],
      calls,
    ),
  );

  assert.deepEqual(
    calls.map((call) => call.argumentsToRun),
    [
      ["queues", "info", queueName],
      ["queues", "create", queueName],
    ],
  );
});

test("accepts a Queue created by a concurrent build", async () => {
  const calls = [];
  await ensureQueueExists(
    queueName,
    [],
    runner(
      [
        missingQueue,
        { exitCode: 1, stdout: "", stderr: "already exists" },
        { exitCode: 0, stdout: "Queue Name", stderr: "" },
      ],
      calls,
    ),
  );

  assert.equal(calls.length, 3);
});

test("reports a Queue creation failure", async () => {
  const calls = [];
  await assert.rejects(
    ensureQueueExists(
      queueName,
      [],
      runner(
        [
          missingQueue,
          { exitCode: 1, stdout: "", stderr: "permission denied" },
          missingQueue,
        ],
        calls,
      ),
    ),
    /Unable to create Queue.*permission denied/s,
  );
});
