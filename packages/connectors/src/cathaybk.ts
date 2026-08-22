import { z } from "zod";

export const cathaybkConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  sessionCookies: z.string().optional(),
  sessionExpiresAt: z.string().optional(),
  browserSessionId: z.string().min(1).optional(),
  browserSessionExpiresAt: z.string().optional(),
  otp: z.string().min(1).optional(),
  otpChannel: z.enum(["email", "sms"]).optional(),
});

export type CathaybkConfig = z.infer<typeof cathaybkConfigSchema>;

export function parseCathaybkConfig(config: unknown): CathaybkConfig {
  return cathaybkConfigSchema.parse(config);
}
