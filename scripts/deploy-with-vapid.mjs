import { createECDH } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const repositoryDirectory = resolve(scriptDirectory, "..");
const invocationDirectory = process.cwd();
const wranglerScript = join(
  repositoryDirectory,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);

const deployArguments = process.argv.slice(2);
const requiredQueueNames = ["taiwan-fin-hub-sync"];

function optionArguments(argumentsToInspect, optionNames) {
  const selected = [];

  for (let index = 0; index < argumentsToInspect.length; index += 1) {
    const argument = argumentsToInspect[index];
    const matchingName = optionNames.find(
      (optionName) =>
        argument === optionName || argument.startsWith(`${optionName}=`),
    );

    if (!matchingName) continue;

    selected.push(argument);
    if (argument === matchingName && argumentsToInspect[index + 1]) {
      selected.push(argumentsToInspect[index + 1]);
      index += 1;
    }
  }

  return selected;
}

function booleanOptionEnabled(argumentsToInspect, optionName) {
  return argumentsToInspect.some(
    (argument) => argument === optionName || argument === `${optionName}=true`,
  );
}

function removeSingleOption(argumentsToInspect, optionName) {
  const remaining = [];
  const values = [];

  for (let index = 0; index < argumentsToInspect.length; index += 1) {
    const argument = argumentsToInspect[index];

    if (argument === optionName) {
      const value = argumentsToInspect[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${optionName} requires a file path.`);
      }
      values.push(value);
      index += 1;
      continue;
    }

    if (argument.startsWith(`${optionName}=`)) {
      const value = argument.slice(optionName.length + 1);
      if (!value) throw new Error(`${optionName} requires a file path.`);
      values.push(value);
      continue;
    }

    remaining.push(argument);
  }

  if (values.length > 1) {
    throw new Error(`${optionName} can only be provided once.`);
  }

  return { remaining, value: values[0] ?? null };
}

function runWrangler(argumentsToRun, options = {}) {
  const { captureOutput = false } = options;
  const child = spawn(process.execPath, [wranglerScript, ...argumentsToRun], {
    cwd: invocationDirectory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME:
        process.env.XDG_CONFIG_HOME ??
        join(invocationDirectory, ".wrangler-config"),
    },
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });

  if (!captureOutput) {
    return new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (exitCode) => resolvePromise({ exitCode }));
    });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (exitCode) =>
      resolvePromise({ exitCode, stdout, stderr }),
    );
  });
}

function generateVapidKeys() {
  const curve = createECDH("prime256v1");
  curve.generateKeys();

  let publicKey = curve.getPublicKey();
  let privateKey = curve.getPrivateKey();

  // Keep the exact fixed-width representation expected by web-push.
  if (privateKey.length < 32) {
    privateKey = Buffer.concat([
      Buffer.alloc(32 - privateKey.length),
      privateKey,
    ]);
  }
  if (publicKey.length < 65) {
    publicKey = Buffer.concat([Buffer.alloc(65 - publicKey.length), publicKey]);
  }

  return {
    publicKey: publicKey.toString("base64url"),
    privateKey: privateKey.toString("base64url"),
  };
}

function isMissingWorkerResult(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  return (
    result.exitCode !== 0 &&
    /worker .* not found|if this is a new worker, run .*wrangler deploy/i.test(
      output,
    )
  );
}

function queueContextArguments() {
  return optionArguments(deployArguments, [
    "--cwd",
    "--config",
    "-c",
    "--env",
    "-e",
    "--env-file",
  ]);
}

function isMissingQueueResult(result, queueName) {
  const output = `${result.stdout}\n${result.stderr}`;
  return (
    result.exitCode !== 0 &&
    output.includes(`Queue "${queueName}" does not exist`)
  );
}

export async function ensureQueueExists(
  queueName,
  contextArguments,
  run = runWrangler,
) {
  const inspect = () =>
    run(["queues", "info", queueName, ...contextArguments], {
      captureOutput: true,
    });
  const existing = await inspect();
  if (existing.exitCode === 0) {
    console.log(`[deploy] Queue '${queueName}' already exists.`);
    return;
  }
  if (!isMissingQueueResult(existing, queueName)) {
    throw new Error(
      `Unable to inspect Queue '${queueName}' before deployment.\n${existing.stderr.trim()}`,
    );
  }

  console.log(`[deploy] Queue '${queueName}' was not found; creating it.`);
  const creation = await run(
    ["queues", "create", queueName, ...contextArguments],
    { captureOutput: true },
  );
  if (creation.exitCode === 0) {
    console.log(`[deploy] Created Queue '${queueName}'.`);
    return;
  }

  // Another concurrent build may have created the shared Queue after our
  // initial check. Confirm the final state before treating creation as failed.
  const afterCreation = await inspect();
  if (afterCreation.exitCode === 0) {
    console.log(`[deploy] Queue '${queueName}' is now available.`);
    return;
  }

  throw new Error(
    `Unable to create Queue '${queueName}' before deployment.\n${creation.stderr.trim()}`,
  );
}

async function ensureRequiredQueues() {
  const contextArguments = queueContextArguments();
  for (const queueName of requiredQueueNames) {
    await ensureQueueExists(queueName, contextArguments);
  }
}

async function existingSecretNames() {
  const contextArguments = optionArguments(deployArguments, [
    "--cwd",
    "--config",
    "-c",
    "--env",
    "-e",
    "--env-file",
    "--name",
  ]);
  const result = await runWrangler(
    ["secret", "list", "--format", "json", ...contextArguments],
    { captureOutput: true },
  );

  if (isMissingWorkerResult(result)) {
    return null;
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to inspect Worker secrets before deployment.\n${result.stderr.trim()}`,
    );
  }

  let secrets;
  try {
    secrets = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Wrangler returned an unexpected secret list response.\n${result.stdout.trim()}`,
    );
  }

  if (!Array.isArray(secrets)) {
    throw new Error("Wrangler returned an invalid Worker secret list.");
  }

  return new Set(secrets.map((secret) => secret?.name).filter(Boolean));
}

function deploymentDirectory() {
  const { value: requestedDirectory } = removeSingleOption(
    deployArguments,
    "--cwd",
  );
  return requestedDirectory
    ? resolve(invocationDirectory, requestedDirectory)
    : invocationDirectory;
}

function parseJsonSecrets(content, filePath) {
  let secrets;
  try {
    secrets = JSON.parse(content);
  } catch {
    return null;
  }

  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error(
      `Secrets file ${filePath} must contain a JSON object or dotenv values.`,
    );
  }

  for (const [key, value] of Object.entries(secrets)) {
    if (value !== null && typeof value !== "string") {
      throw new Error(
        `Secret ${key} in ${filePath} must be a string or null value.`,
      );
    }
  }

  return secrets;
}

function parseDotenvVapidSecrets(content) {
  const secrets = {};

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?(VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY)\s*=\s*(.*)\s*$/,
    );
    if (!match) continue;

    const value = match[2].trim();
    const quotedValue = value.match(/^(['"])(.*?)\1(?:\s*#.*)?$/);
    secrets[match[1]] = quotedValue
      ? quotedValue[2]
      : value.replace(/\s*#.*$/, "").trim();
  }

  return secrets;
}

function providedVapidKeys(secrets, filePath) {
  const publicKey = secrets.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = secrets.VAPID_PRIVATE_KEY?.trim() ?? "";

  if (Boolean(publicKey) !== Boolean(privateKey)) {
    throw new Error(
      `Secrets file ${filePath} must provide both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither.`,
    );
  }

  if (!publicKey) return null;

  return {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
  };
}

function generateVapidSecrets() {
  const keys = generateVapidKeys();
  return {
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
  };
}

async function createInitialSecretsFile(temporaryDirectory, suppliedSecrets) {
  if (!suppliedSecrets) {
    const vapidKeys = generateVapidSecrets();
    const secretsFile = join(temporaryDirectory, "secrets.json");
    await writeFile(secretsFile, `${JSON.stringify(vapidKeys)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { secretsFile, generated: true };
  }

  const { content, parsedJson, vapidKeys: existingVapidKeys } = suppliedSecrets;
  const vapidKeys = existingVapidKeys ?? generateVapidSecrets();
  const secretsFile = join(
    temporaryDirectory,
    parsedJson ? "secrets.json" : "secrets.env",
  );

  if (parsedJson) {
    await writeFile(
      secretsFile,
      `${JSON.stringify({ ...parsedJson, ...vapidKeys })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return { secretsFile, generated: existingVapidKeys === null };
  }

  const vapidLines = existingVapidKeys
    ? ""
    : `VAPID_PUBLIC_KEY=${vapidKeys.VAPID_PUBLIC_KEY}\nVAPID_PRIVATE_KEY=${vapidKeys.VAPID_PRIVATE_KEY}\n`;
  await writeFile(secretsFile, `${content.trimEnd()}\n${vapidLines}`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { secretsFile, generated: existingVapidKeys === null };
}

async function readSuppliedSecretsFile(sourceFile, effectiveDirectory) {
  if (!sourceFile) return null;

  const sourcePath = resolve(effectiveDirectory, sourceFile);
  const content = await readFile(sourcePath, "utf8");
  const parsedJson = parseJsonSecrets(content, sourceFile);
  const secrets = parsedJson ?? parseDotenvVapidSecrets(content);

  return {
    content,
    parsedJson,
    vapidKeys: providedVapidKeys(secrets, sourceFile),
  };
}

async function deploy() {
  if (booleanOptionEnabled(deployArguments, "--dry-run")) {
    const result = await runWrangler(["deploy", ...deployArguments]);
    if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
    return;
  }

  await ensureRequiredQueues();

  const { remaining: deployArgumentsWithoutSecretsFile, value: sourceFile } =
    removeSingleOption(deployArguments, "--secrets-file");
  const effectiveDirectory = deploymentDirectory();
  const suppliedSecrets = await readSuppliedSecretsFile(
    sourceFile,
    effectiveDirectory,
  );
  const secrets = await existingSecretNames();
  const hasPublicKey = secrets?.has("VAPID_PUBLIC_KEY") ?? false;
  const hasPrivateKey = secrets?.has("VAPID_PRIVATE_KEY") ?? false;
  const needsInitialKeys =
    secrets === null || (!hasPublicKey && !hasPrivateKey);

  if (hasPublicKey !== hasPrivateKey && !needsInitialKeys) {
    throw new Error(
      "Worker has only one VAPID secret configured. Refusing to rotate the existing key; restore both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY manually.",
    );
  }

  if (!needsInitialKeys) {
    const result = await runWrangler(["deploy", ...deployArguments]);
    if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
    return;
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "taiwan-fin-hub-vapid-"),
  );

  try {
    const { secretsFile, generated } = await createInitialSecretsFile(
      temporaryDirectory,
      suppliedSecrets,
    );
    console.log(
      generated
        ? "[deploy] No VAPID key pair found; generating one for this Worker."
        : "[deploy] Using the VAPID key pair from the supplied secrets file.",
    );

    const result = await runWrangler([
      "deploy",
      ...deployArgumentsWithoutSecretsFile,
      "--secrets-file",
      secretsFile,
    ]);
    if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await deploy();
}
