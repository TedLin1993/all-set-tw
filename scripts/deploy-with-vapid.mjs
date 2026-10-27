import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";
import { prepareAccessSetup } from "./cloudflare-access.mjs";

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

// Each new Worker downloads this public file once. GitHub only exposes the
// asset's total download count, so the request carries no deployment data.
const deploymentCounterUrl =
  "https://github.com/TedLin1993/all-set-tw/releases/download/deploy-counter/first-deploy.txt";
const deploymentCounterTimeoutMs = 5000;

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

async function countFirstDeployment(environment, fetchPublic = fetch) {
  if (
    environment.WORKERS_CI !== "1" ||
    environment.DEPLOY_COUNTER === "false"
  ) {
    return;
  }

  try {
    const response = await fetchPublic(deploymentCounterUrl, {
      signal: AbortSignal.timeout(deploymentCounterTimeoutMs),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(
      "[deploy] Counted this first deployment by downloading a public GitHub Release file once; no deployment data was sent. Set the build variable DEPLOY_COUNTER=false to disable.",
    );
  } catch {
    console.log("[deploy] First-deployment count skipped.");
  }
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

function queueContextArguments(argumentsToDeploy = deployArguments) {
  return optionArguments(argumentsToDeploy, [
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

export async function ensureRequiredQueues(
  contextArguments = queueContextArguments(),
  run = runWrangler,
  config,
) {
  config ??= await readDeploymentConfig(contextArguments);
  const queueNames = new Set([
    ...(config.queues?.producers ?? []).map((producer) => producer.queue),
    ...(config.queues?.consumers ?? []).map((consumer) => consumer.queue),
  ]);
  for (const queueName of queueNames) {
    if (!queueName) continue;
    await ensureQueueExists(queueName, contextArguments, run);
  }
}

export async function prepareDeploymentQueues(
  argumentsToDeploy,
  { run, environment, readConfig = readDeploymentConfig },
) {
  const config = await readConfig(argumentsToDeploy);
  const contextArguments = queueContextArguments(argumentsToDeploy);
  await ensureRequiredQueues(contextArguments, run, config);
  const producer = config.queues?.producers?.find(
    (binding) => binding.binding === "SYNC_QUEUE",
  );
  if (
    !producer?.queue ||
    !config.queues?.consumers?.some(
      (consumer) => consumer.queue === producer.queue,
    )
  ) {
    return { argumentsToDeploy, temporaryConfig: null };
  }

  const workerName = environment.WRANGLER_CI_OVERRIDE_NAME ?? config.name;
  if (!workerName) throw new Error("Queue setup requires the Worker name.");
  const inspect = async (queueName) => {
    const result = await run(
      ["queues", "consumer", "list", queueName, "--json", ...contextArguments],
      { captureOutput: true },
    );
    if (isMissingQueueResult(result, queueName)) return null;
    if (result.exitCode !== 0) {
      throw new Error(
        `Unable to inspect consumers for Queue '${queueName}'.\n${result.stderr.trim()}`,
      );
    }
    const consumers = JSON.parse(result.stdout);
    if (!Array.isArray(consumers)) {
      throw new Error(`Invalid consumer list for Queue '${queueName}'.`);
    }
    return consumers;
  };
  const belongsToWorker = (consumer) =>
    consumer.type === "worker" &&
    [consumer.script, consumer.service, consumer.script_name].includes(
      workerName,
    );
  const occupied = (consumers) =>
    consumers?.some((consumer) => !belongsToWorker(consumer));
  const ownQueueName = (suffix = "") =>
    `${workerName.slice(0, 58 - suffix.length)}-sync${suffix}`;

  let selectedQueue = producer.queue;
  const configuredConsumers = await inspect(selectedQueue);
  if (
    configuredConsumers?.some(belongsToWorker) &&
    !occupied(configuredConsumers)
  ) {
    return { argumentsToDeploy, temporaryConfig: null };
  }
  // Keep an earlier fallback even if the originally configured Queue is freed.
  let candidate = ownQueueName();
  let candidateConsumers =
    candidate === selectedQueue
      ? configuredConsumers
      : await inspect(candidate);
  let suffix = 1;
  while (occupied(candidateConsumers)) {
    candidate = ownQueueName(`-${++suffix}`);
    candidateConsumers = await inspect(candidate);
  }
  if (
    candidateConsumers?.some(belongsToWorker) &&
    !occupied(candidateConsumers)
  ) {
    selectedQueue = candidate;
  } else if (occupied(configuredConsumers)) {
    selectedQueue = candidate;
  }
  if (selectedQueue === producer.queue) {
    return { argumentsToDeploy, temporaryConfig: null };
  }

  await ensureQueueExists(selectedQueue, contextArguments, run);
  const { experimental_readRawConfig } = await import("wrangler");
  const { rawConfig } = experimental_readRawConfig({
    config: config.configPath,
  });
  const target = config.targetEnvironment
    ? rawConfig.env[config.targetEnvironment]
    : rawConfig;
  target.queues.producers = target.queues.producers.map((binding) =>
    binding.binding === "SYNC_QUEUE"
      ? { ...binding, queue: selectedQueue }
      : binding,
  );
  target.queues.consumers = target.queues.consumers.map((consumer) =>
    consumer.queue === producer.queue
      ? { ...consumer, queue: selectedQueue }
      : consumer,
  );
  const withoutLongConfig = removeSingleOption(
    argumentsToDeploy,
    "--config",
  ).remaining;
  const withoutConfig = removeSingleOption(withoutLongConfig, "-c").remaining;
  // Keeping the file beside the source config preserves relative paths.
  const temporaryConfig = join(
    dirname(config.configPath),
    `.wrangler-queue-${randomUUID()}.json`,
  );
  await writeFile(temporaryConfig, `${JSON.stringify(rawConfig)}\n`, {
    mode: 0o600,
  });
  console.log(
    `[deploy] Using dedicated Queue '${selectedQueue}' for Worker '${workerName}'.`,
  );
  return {
    argumentsToDeploy: [...withoutConfig, "--config", temporaryConfig],
    temporaryConfig,
  };
}

async function existingSecretNames(argumentsToDeploy, run, environment) {
  const guiWorkerName = environment.WRANGLER_CI_OVERRIDE_NAME;
  // secret list does not apply the Builds name override. With --name, --env
  // would append a suffix to the GUI's already complete Worker name.
  const contextArguments = optionArguments(argumentsToDeploy, [
    "--cwd",
    "--config",
    "-c",
    ...(guiWorkerName ? [] : ["--env", "-e"]),
    "--env-file",
    ...(guiWorkerName ? [] : ["--name"]),
  ]);
  if (guiWorkerName) contextArguments.push("--name", guiWorkerName);
  const result = await run(
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

function deploymentDirectory(argumentsToDeploy) {
  const { value: requestedDirectory } = removeSingleOption(
    argumentsToDeploy,
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

async function createInitialSecretsFile(
  temporaryDirectory,
  suppliedSecrets,
  initialSecrets,
) {
  const { content, parsedJson } = suppliedSecrets ?? {};
  const secretsFile = join(
    temporaryDirectory,
    !suppliedSecrets || parsedJson ? "secrets.json" : "secrets.env",
  );

  if (!suppliedSecrets || parsedJson) {
    await writeFile(
      secretsFile,
      `${JSON.stringify({ ...parsedJson, ...initialSecrets })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } else {
    const initialLines = Object.entries(initialSecrets)
      .map(([name, value]) => `${name}=${value}\n`)
      .join("");
    await writeFile(secretsFile, `${content.trimEnd()}\n${initialLines}`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return secretsFile;
}

async function readSuppliedSecretsFile(sourceFile, effectiveDirectory) {
  if (!sourceFile) return null;

  const sourcePath = resolve(effectiveDirectory, sourceFile);
  const content = await readFile(sourcePath, "utf8");
  const parsedJson = parseJsonSecrets(content, sourceFile);
  const secrets = parsedJson ?? parseEnv(content);

  return {
    content,
    parsedJson,
    values: secrets,
    vapidKeys: providedVapidKeys(secrets, sourceFile),
  };
}

export async function readDeploymentConfig(argumentsToDeploy) {
  const { unstable_readConfig } = await import("wrangler");
  const effectiveDirectory = deploymentDirectory(argumentsToDeploy);
  const valueOf = (names) => {
    const selected = optionArguments(argumentsToDeploy, names);
    const last = selected.at(-1);
    return last?.includes("=") ? last.slice(last.indexOf("=") + 1) : last;
  };
  const configFile = valueOf(["--config", "-c"]) ?? "wrangler.toml";
  const config = unstable_readConfig(
    {
      config: resolve(effectiveDirectory, configFile),
      env: valueOf(["--env", "-e"]),
    },
    { hideWarnings: true },
  );
  return { ...config, name: valueOf(["--name"]) ?? config.name };
}

async function needsGeneratedConfigEncryptionKey(
  argumentsToDeploy,
  { run, config, existingSecrets, suppliedSecrets },
) {
  if (
    existingSecrets?.has("GENERATED_CONFIG_ENCRYPTION_KEY") ||
    suppliedSecrets?.GENERATED_CONFIG_ENCRYPTION_KEY
  ) {
    return false;
  }
  const configuredKey =
    suppliedSecrets?.CONFIG_ENCRYPTION_KEY ??
    config.vars?.CONFIG_ENCRYPTION_KEY;
  if (configuredKey && configuredKey !== "auto") return false;

  // Inspect only existence, never encrypted records or credentials. A lost
  // key must not be replaced with a new one once encrypted data exists.
  const result = await run(
    [
      "d1",
      "execute",
      "DB",
      "--remote",
      "--json",
      "--command",
      `SELECT
        EXISTS(SELECT 1 FROM connector_settings) OR
        EXISTS(SELECT 1 FROM push_subscriptions) OR
        EXISTS(SELECT 1 FROM tdcc_sync_runs
          WHERE encrypted_config IS NOT NULL OR encrypted_session IS NOT NULL)
        AS has_encrypted_data`,
      ...queueContextArguments(argumentsToDeploy),
    ],
    { captureOutput: true },
  );
  let hasEncryptedData;
  if (result.exitCode === 0) {
    try {
      const response = JSON.parse(result.stdout);
      if (response.length === 1 && response[0].success === true) {
        hasEncryptedData = response[0].results?.[0]?.has_encrypted_data;
      }
    } catch {
      // Fail closed without including a possibly sensitive CLI response.
    }
  }
  if (hasEncryptedData !== 0 && hasEncryptedData !== 1) {
    throw new Error(
      "Unable to inspect encrypted D1 data. Refusing to initialize GENERATED_CONFIG_ENCRYPTION_KEY; check the DB binding and apply migrations before deploying.",
    );
  }
  if (hasEncryptedData === 0) return true;

  if (
    configuredKey === "auto" ||
    !existingSecrets?.has("CONFIG_ENCRYPTION_KEY")
  ) {
    throw new Error(
      "D1 already contains encrypted data, but GENERATED_CONFIG_ENCRYPTION_KEY is missing. Refusing to generate a replacement; restore the original encryption key before using auto.",
    );
  }
  // Cloudflare exposes secret names, not values. An older installation with
  // a manual key can update normally; auto with a lost key fails at runtime.
  console.warn(
    "[deploy] D1 contains encrypted data; keeping the existing CONFIG_ENCRYPTION_KEY without generating a new key. If it is auto, restore the original GENERATED_CONFIG_ENCRYPTION_KEY.",
  );
  return false;
}

async function deployPrepared(
  argumentsToDeploy,
  { run, environment, readConfig, fetchApi, fetchPublic },
) {
  const { remaining: deployArgumentsWithoutSecretsFile, value: sourceFile } =
    removeSingleOption(argumentsToDeploy, "--secrets-file");
  const effectiveDirectory = deploymentDirectory(argumentsToDeploy);
  const suppliedSecrets = await readSuppliedSecretsFile(
    sourceFile,
    effectiveDirectory,
  );
  const secrets = await existingSecretNames(
    argumentsToDeploy,
    run,
    environment,
  );
  const hasPublicKey = secrets?.has("VAPID_PUBLIC_KEY") ?? false;
  const hasPrivateKey = secrets?.has("VAPID_PRIVATE_KEY") ?? false;
  const needsInitialKeys =
    secrets === null || (!hasPublicKey && !hasPrivateKey);

  if (hasPublicKey !== hasPrivateKey && !needsInitialKeys) {
    throw new Error(
      "Worker has only one VAPID secret configured. Refusing to rotate the existing key; restore both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY manually.",
    );
  }

  const config = await readConfig(argumentsToDeploy);
  const needsEncryptionKey = await needsGeneratedConfigEncryptionKey(
    argumentsToDeploy,
    {
      run,
      config,
      existingSecrets: secrets,
      suppliedSecrets: suppliedSecrets?.values,
    },
  );

  let accessSetup = null;
  if (
    environment.WORKERS_CI === "1" &&
    environment.ACCESS_AUTO_SETUP !== "false"
  ) {
    accessSetup = await prepareAccessSetup({
      environment,
      config,
      existingSecrets: secrets,
      suppliedSecrets: suppliedSecrets?.values,
      fetchApi,
      fetchPublic,
    });
  }

  const temporaryDirectory =
    needsInitialKeys || needsEncryptionKey || accessSetup
      ? await mkdtemp(join(tmpdir(), "taiwan-fin-hub-deploy-"))
      : null;

  try {
    let argumentsForUpload = argumentsToDeploy;
    if (needsInitialKeys || needsEncryptionKey) {
      const initialSecrets = {
        ...(needsInitialKeys && !suppliedSecrets?.vapidKeys
          ? generateVapidSecrets()
          : {}),
        ...(needsEncryptionKey
          ? { GENERATED_CONFIG_ENCRYPTION_KEY: randomBytes(32).toString("hex") }
          : {}),
      };
      const secretsFile = await createInitialSecretsFile(
        temporaryDirectory,
        suppliedSecrets,
        initialSecrets,
      );
      if (needsInitialKeys) {
        console.log(
          suppliedSecrets?.vapidKeys
            ? "[deploy] Using the VAPID key pair from the supplied secrets file."
            : "[deploy] No VAPID key pair found; generating one for this Worker.",
        );
      }
      if (needsEncryptionKey) {
        console.log(
          "[deploy] Initializing GENERATED_CONFIG_ENCRYPTION_KEY for this Worker; future deployments will preserve it.",
        );
      }
      argumentsForUpload = [
        ...deployArgumentsWithoutSecretsFile,
        "--secrets-file",
        secretsFile,
      ];
    }

    const result = await run(["deploy", ...argumentsForUpload]);
    if (result.exitCode !== 0) return result.exitCode ?? 1;
    if (needsInitialKeys) {
      await countFirstDeployment(environment, fetchPublic);
    }

    if (accessSetup) {
      const accessSecrets = await accessSetup.complete();
      const secretsFile = join(temporaryDirectory, "access-secrets.json");
      await writeFile(secretsFile, `${JSON.stringify(accessSecrets)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      // Upload a deployed version with the derived values. Wrangler preserves
      // secrets not included here, including both encryption keys and VAPID.
      const configured = await run([
        "deploy",
        ...deployArgumentsWithoutSecretsFile,
        "--secrets-file",
        secretsFile,
      ]);
      if (configured.exitCode !== 0) {
        throw new Error(
          "Worker Access is configured, but deploying its verification secrets failed. Retry the Cloudflare GUI deployment to finish setup.",
        );
      }
      console.log(
        "[deploy] TEAM_DOMAIN and POLICY_AUD configured automatically.",
      );
    }
    return 0;
  } finally {
    if (temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function deploy(
  argumentsToDeploy = deployArguments,
  {
    run = runWrangler,
    environment = process.env,
    readConfig = readDeploymentConfig,
    fetchApi,
    fetchPublic,
  } = {},
) {
  if (booleanOptionEnabled(argumentsToDeploy, "--dry-run")) {
    const result = await run(["deploy", ...argumentsToDeploy]);
    return result.exitCode ?? 1;
  }
  const prepared = await prepareDeploymentQueues(argumentsToDeploy, {
    run,
    environment,
    readConfig,
  });
  try {
    return await deployPrepared(prepared.argumentsToDeploy, {
      run,
      environment,
      readConfig,
      fetchApi,
      fetchPublic,
    });
  } finally {
    if (prepared.temporaryConfig) {
      await rm(prepared.temporaryConfig, { force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = await deploy();
  } catch (error) {
    console.error(`[deploy] ${error.message}`);
    process.exitCode = 1;
  }
}
