import type { MiddlewareHandler } from "hono";
import { sanitizeDatabaseError } from "@taiwan-fin-hub/db";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppBindings, Env } from "./env";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function jsonError(code: string, message: string, status = 400) {
  return Response.json(
    {
      success: false,
      error: { code, message },
    },
    { status },
  );
}

export function apiErrorResponse(error: Error) {
  if (error instanceof HTTPException && error.status === 400) {
    return jsonError(
      "INVALID_REQUEST",
      "Request data does not match the expected format.",
      400,
    );
  }

  if (error instanceof z.ZodError) {
    return jsonError(
      "INVALID_REQUEST",
      "Request data does not match the expected format.",
      400,
    );
  }

  console.error("[api] unhandled error:", sanitizeDatabaseError(error));
  return jsonError("INTERNAL_ERROR", "An unexpected error occurred.", 500);
}

export function isDemoMode(env: Pick<Env, "DEMO_MODE">) {
  if (env.DEMO_MODE === true) return true;
  if (typeof env.DEMO_MODE !== "string") return false;
  return ["1", "true", "yes", "on"].includes(
    env.DEMO_MODE.trim().toLowerCase(),
  );
}

export const demoReadOnlyMiddleware: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  if (!isDemoMode(c.env) || SAFE_METHODS.has(c.req.method.toUpperCase())) {
    await next();
    return;
  }

  return c.json(
    {
      success: false as const,
      error: {
        code: "DEMO_MODE_READ_ONLY",
        message: "Demo site is read-only.",
      },
    },
    403,
  );
};

const paginationLimitSchema = z.coerce.number().int().min(1).max(100);

export function parseKeysetPagination<T extends z.ZodTypeAny>(
  query: Record<string, string | undefined>,
  cursorSchema: T,
  defaultLimit = 50,
): { limit: number; cursor?: z.infer<T> } {
  const limit = paginationLimitSchema.parse(query.limit ?? defaultLimit);
  return query.cursor
    ? { limit, cursor: cursorSchema.parse(decodePageCursor(query.cursor)) }
    : { limit };
}

export function encodePageCursor(value: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function setKeysetPaginationHeaders(
  headers: (name: string, value: string) => void,
  input: { hasMore: boolean; nextCursor?: string },
) {
  headers("X-Has-More", String(input.hasMore));
  if (input.hasMore && input.nextCursor)
    headers("X-Next-Cursor", input.nextCursor);
}

function decodePageCursor(value: string) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["cursor"],
        message: "Invalid pagination cursor.",
      },
    ]);
  }
}
