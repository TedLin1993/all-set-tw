import { drizzle } from "drizzle-orm/d1";

/** Wrap this invocation's D1 binding as a Drizzle client. Not a connection pool or DbContext. */
export function createDrizzle(binding: D1Database) {
  // Query builders import their tables explicitly; no relational schema registry
  // or client is retained across requests / Queue invocations.
  return drizzle(binding, { logger: false });
}

export type AppDatabase = ReturnType<typeof createDrizzle>;
