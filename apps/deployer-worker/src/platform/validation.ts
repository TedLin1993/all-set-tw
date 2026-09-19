import { jsonError } from "./http";

export function validationHook(code: string, message: string, status = 400) {
  return (result: { success: boolean }) => {
    if (!result.success) return jsonError(code, message, status);
  };
}
