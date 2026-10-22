import type { ConnectorId } from "@taiwan-fin-hub/shared";
import { sourceSyncErrorOf } from "../../sources/sync-error";

export class SyncAlreadyRunningError extends Error {
  constructor(readonly connectorId: ConnectorId) {
    super(`${connectorId} sync is already running.`);
  }
}

export class NeedsUserActionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** 自動辨識驗證碼失敗，前端應直接改走人工驗證碼流程。 */
export class ManualCaptchaRequiredError extends NeedsUserActionError {}

export class NextbankCaptchaRequiredError extends NeedsUserActionError {}

/** 來源錯誤以 `toSyncError().needsUserAction` 自行宣告；未宣告時依錯誤訊息判斷。 */
export function isUserActionError(error: unknown) {
  const declared = sourceSyncErrorOf(error)?.needsUserAction;
  if (declared !== undefined) return declared;
  if (error instanceof NeedsUserActionError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /OTP|verification|requires.*login|requires.*session|requires.*user action/i.test(
    message,
  );
}

export function safeErrorMessage(error: unknown) {
  const message = normalizeErrorText(
    redactSensitiveText(
      error instanceof Error
        ? error.message
        : error === null || error === undefined
          ? ""
          : String(error),
    ),
    300,
  );
  return message || "同步失敗，但未取得錯誤原因。";
}

export function safeErrorLogDetails(error: unknown) {
  const errorName = normalizeErrorText(
    error instanceof Error ? error.name : typeof error,
    80,
  );
  const stack =
    error instanceof Error
      ? sanitizeErrorDiagnostic(
          (error.stack ?? "").split("\n").slice(1).join("\n"),
          1_500,
        )
      : "";
  const cause = error instanceof Error ? error.cause : undefined;
  const causeName =
    cause instanceof Error
      ? normalizeErrorText(cause.name, 80) || "UnknownError"
      : "";
  const causeStack =
    cause instanceof Error
      ? sanitizeErrorDiagnostic(
          (cause.stack ?? "").split("\n").slice(1).join("\n"),
          500,
        )
      : "";
  const stage =
    error instanceof Error &&
    "stage" in error &&
    typeof error.stage === "string"
      ? normalizeErrorText(error.stage, 80)
      : "";

  return {
    errorName: errorName || "UnknownError",
    ...(stage ? { stage } : {}),
    ...(stack ? { stack } : {}),
    ...(causeName ? { causeName } : {}),
    ...(causeStack ? { causeStack } : {}),
  };
}

function normalizeErrorText(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeErrorDiagnostic(value: string, maxLength: number) {
  return redactSensitiveText(value).trim().slice(0, maxLength);
}

// Upstream error text can echo account identifiers or tokens; redact before it
// reaches sync records, API responses, or logs.
function redactSensitiveText(value: string) {
  return value
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(
      /\b(authorization|cookie|password|passwd|token|secret|session(?:cookies?)?)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9+/_=-]{24,}\b/g, "[redacted]")
    .replace(/\b[A-Z][1289]\d{8}\b/g, "[redacted]")
    .replace(/\b\d{10,}\b/g, "[redacted]");
}
