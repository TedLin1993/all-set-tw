import { z } from "zod";

/** 永豐行動網銀登入與 App JSON API 同步設定。機密欄位會由 Worker 加密儲存。 */
export const sinopacConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  sessionCookies: z.string().optional(),
  browserSessionId: z.string().optional(),
  browserSessionExpiresAt: z.string().optional(),
  captcha: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  protocol: z.literal("sinopac-mobile-app-json-v1").optional(),
  lookbackMonths: z.coerce.number().int().min(1).max(24).optional(),
});

export type SinopacConfig = z.infer<typeof sinopacConfigSchema>;

export function parseSinopacConfig(config: unknown) {
  return sinopacConfigSchema.parse(config);
}
