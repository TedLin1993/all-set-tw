import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

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
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-06-01",
      d1Databases: { DB: crypto.randomUUID() },
      logRequests: false,
    }),
  );
  try {
    const binding = await mf.getD1Database("DB");
    for (const migration of readMigrations()) {
      const statements = unstable_splitSqlQuery(migration)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
        .map((statement) => binding.prepare(statement));
      if (statements.length > 0) {
        await binding.batch(statements);
      }
    }
    return { binding, mf };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
