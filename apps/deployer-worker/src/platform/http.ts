import { HTTPException } from "hono/http-exception";
import { z } from "zod";

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

  console.error(
    "[deployer] unhandled error",
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { message: "unknown" },
  );
  return jsonError("INTERNAL_ERROR", "An unexpected error occurred.", 500);
}

export function isLocalDevMode(env: { LOCAL_DEV_MODE?: string | boolean }) {
  if (env.LOCAL_DEV_MODE === true) return true;
  if (typeof env.LOCAL_DEV_MODE !== "string") return false;
  return ["1", "true", "yes", "on"].includes(
    env.LOCAL_DEV_MODE.trim().toLowerCase(),
  );
}
