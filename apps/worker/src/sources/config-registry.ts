import type {
  ConnectorId,
  ConnectorSessionState,
} from "@taiwan-fin-hub/shared";
import type { z } from "zod";
import { invoiceConfigSchema } from "./einvoice/protocol";
import { describeTdccSession, tdccConfigSchema } from "./tdcc/protocol";
import { esunConfigSchema } from "./esun/protocol";
import {
  cathaybkConfigSchema,
  describeCathaybkSession,
} from "./cathaybk/protocol";
import {
  describeSinopacSession,
  sinopacConfigSchema,
} from "./sinopac/protocol";
import { taishinConfigSchema } from "./taishin/protocol";
import {
  ctbcConfigSchema,
  ctbcIdentityReset,
  describeCtbcSession,
} from "./ctbc/protocol";
import { skbankConfigSchema } from "./skbank/protocol";
import { obankConfigSchema } from "./obank/protocol";
import { nextbankConfigSchema } from "./nextbank/protocol";
import { firstbankConfigSchema } from "./firstbank/protocol";
import { hncbConfigSchema } from "./hncb/protocol";
import { rakutenConfigSchema } from "./rakuten/protocol";
import { kgibankConfigSchema } from "./kgibank/protocol";
import { megabankConfigSchema } from "./megabank/protocol";
import { fubonConfigSchema } from "./fubon/protocol";
import { feibConfigSchema } from "./feib/protocol";

export const connectorConfigSchemas = {
  einvoice: invoiceConfigSchema,
  tdcc: tdccConfigSchema,
  esun: esunConfigSchema,
  cathaybk: cathaybkConfigSchema,
  sinopac: sinopacConfigSchema,
  taishin: taishinConfigSchema,
  ctbc: ctbcConfigSchema,
  skbank: skbankConfigSchema,
  obank: obankConfigSchema,
  nextbank: nextbankConfigSchema,
  firstbank: firstbankConfigSchema,
  hncb: hncbConfigSchema,
  rakuten: rakutenConfigSchema,
  kgibank: kgibankConfigSchema,
  megabank: megabankConfigSchema,
  fubon: fubonConfigSchema,
  feib: feibConfigSchema,
} satisfies Record<ConnectorId, z.ZodType>;

export function parseConnectorConfig(
  connectorId: ConnectorId,
  config: unknown,
) {
  return connectorConfigSchemas[connectorId].parse(config);
}

type SessionDescriptor = (
  stored: Record<string, unknown>,
  credentialsComplete: boolean,
) => Partial<ConnectorSessionState>;

/** 不保存可沿用 session 或待驗證狀態的來源。 */
const noSession: SessionDescriptor = () => ({});

/** 保存 Browser session cookie 的來源，cookie 存在即視為可沿用。 */
const browserCookieSession: SessionDescriptor = (stored) => ({
  sessionAvailable:
    typeof stored.sessionCookies === "string" &&
    stored.sessionCookies.length > 0,
});

const connectorSessionDescriptors = {
  einvoice: noSession,
  tdcc: describeTdccSession,
  esun: browserCookieSession,
  cathaybk: describeCathaybkSession,
  sinopac: describeSinopacSession,
  taishin: browserCookieSession,
  ctbc: describeCtbcSession,
  skbank: noSession,
  obank: noSession,
  nextbank: noSession,
  firstbank: browserCookieSession,
  hncb: browserCookieSession,
  rakuten: noSession,
  kgibank: noSession,
  megabank: noSession,
  fubon: noSession,
  feib: noSession,
} satisfies Record<ConnectorId, SessionDescriptor>;

/** 由解密後的設定判斷設定頁顯示的 session 與待驗證狀態，不回傳任何 secret。 */
export function describeConnectorSession(
  connectorId: ConnectorId,
  stored: Record<string, unknown>,
  credentialsComplete: boolean,
): ConnectorSessionState {
  return {
    sessionAvailable: false,
    verificationPending: false,
    verificationChannel: null,
    verificationExpiresAt: null,
    ...connectorSessionDescriptors[connectorId](stored, credentialsComplete),
  };
}

/**
 * 指定帳密欄位變更時，額外清除的 secret state；
 * 補充 catalog 的 `resetOnCredentialChangeFields`。
 */
export const connectorIdentityResets: Partial<
  Record<ConnectorId, { fields: readonly string[]; reset: readonly string[] }>
> = {
  ctbc: ctbcIdentityReset,
};
