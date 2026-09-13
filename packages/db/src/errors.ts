import { DrizzleQueryError } from "drizzle-orm";

/** Drizzle embeds bound values in message, params and cause; never log them. */
export function sanitizeDatabaseError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  return new Error("Database query failed.");
}
