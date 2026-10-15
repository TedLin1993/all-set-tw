import type { ApiErrorCode } from "@taiwan-fin-hub/shared";
import { jsonError } from "./http";

export function validationHook(
  code: ApiErrorCode,
  message: string,
  status = 400,
) {
  return (result: { success: boolean }) => {
    if (!result.success) return jsonError(code, message, status);
  };
}
