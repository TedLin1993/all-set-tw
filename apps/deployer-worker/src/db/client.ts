import { drizzle } from "drizzle-orm/d1";

/** Wrap this invocation's D1 binding. Not a connection pool. */
export function createDrizzle(binding: D1Database) {
  return drizzle(binding, { logger: false });
}

export type DeployerDatabase = ReturnType<typeof createDrizzle>;
