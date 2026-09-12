import { drizzle } from "drizzle-orm/d1";

export function createDb(binding: D1Database) {
  // Query builders import their tables explicitly; no relational schema registry
  // or client is retained across requests / Queue invocations.
  return drizzle(binding, { logger: false });
}

export type AppDatabase = ReturnType<typeof createDb>;
