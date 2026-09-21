import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyRelease } from "./release/artifact.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { sha256: { type: "string" } },
});
if (positionals.length !== 1)
  throw new Error(
    "Usage: npm run release:verify -- <directory> [--sha256 <trusted digest>]",
  );
const { manifest, digest } = await verifyRelease(
  resolve(positionals[0]),
  values.sha256,
);
console.log(
  `Verified ${manifest.version}: ${manifest.files.length} files, ${manifest.migrations.length} migrations, SHA-256 ${digest}${manifest.sourceDirty ? " (local dirty build; not publishable)" : ""}`,
);
