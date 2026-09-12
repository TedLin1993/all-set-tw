import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

export function readMigrations() {
  return readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`${migrationsDirectory}/${name}`, "utf8"));
}

/** Isolated, in-memory workerd D1; never loads the project's remote bindings. */
export async function createTestD1(
  script = 'export default { fetch() { return new Response("ok"); } };',
) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-06-01",
    d1Databases: ["DB"],
    d1Persist: false,
  }));
  try {
    const binding = await mf.getD1Database("DB");
    for (const migration of readMigrations()) {
      await binding.batch(
        unstable_splitSqlQuery(migration).map((statement) => binding.prepare(statement)),
      );
    }
    return { binding, mf };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
