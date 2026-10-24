import {
  connectorCatalog,
  type ConnectorId,
  type SyncErrorCode,
} from "@taiwan-fin-hub/shared";
import { z } from "zod";
import type { SyncTrigger } from "../../db";
import type { Env } from "../../platform/env";
import {
  prepareSinopacCaptchaSession,
  syncSinopac,
  type SinopacSyncOverrides,
} from "../../sources/sinopac/sync";
import {
  prepareHncbCaptchaSession,
  syncHncb,
  type HncbSyncOverrides,
} from "../../sources/hncb/sync";
import {
  prepareKgibankCaptchaSession,
  syncKgibank,
  type KgibankSyncOverrides,
} from "../../sources/kgibank/sync";
import {
  prepareRakutenCaptchaSession,
  syncRakuten,
  type RakutenSyncOverrides,
} from "../../sources/rakuten/sync";
import {
  prepareTaishinCaptchaSession,
  syncTaishin,
  type TaishinSyncOverrides,
} from "../../sources/taishin/sync";
import {
  prepareObankCaptchaSession,
  syncObank,
  type ObankSyncOverrides,
} from "../../sources/obank/sync";
import {
  prepareFirstbankCaptchaSession,
  syncFirstbank,
  type FirstbankSyncOverrides,
} from "../../sources/firstbank/sync";
import {
  prepareMegabankCaptchaSession,
  syncMegabank,
  type MegabankSyncOverrides,
} from "../../sources/megabank/sync";
import {
  prepareFubonCaptchaSession,
  syncFubon,
  type FubonSyncOverrides,
} from "../../sources/fubon/sync";
import {
  prepareFeibCaptchaSession,
  syncFeib,
  type FeibSyncOverrides,
} from "../../sources/feib/sync";
import {
  syncCathaybk,
  type CathaySyncOverrides,
} from "../../sources/cathaybk/sync";
import { syncCtbc } from "../../sources/ctbc/sync";
import type { CtbcSyncOverrides } from "../../sources/ctbc/mobile-api";
import { syncSkbank } from "../../sources/skbank/sync";
import { syncUbot } from "../../sources/ubot/sync";
import { syncEsun } from "../../sources/esun/sync";
import {
  syncNextbank,
  prepareNextbankCaptchaSession,
} from "../../sources/nextbank/sync";
import { SYNC_SCOPE_ALL, type SyncOutcome, type SyncScope } from "./types";

const sinopacSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

const taishinSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
});

const hncbSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
});

const rakutenSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/)
    .optional(),
});

const kgibankSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

const obankSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/)
    .optional(),
});

const firstbankSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4,8}$/)
    .optional(),
});

const cathaySyncBodySchema = z.object({
  otp: z.string().min(1).optional(),
  otpChannel: z.enum(["email", "sms"]).optional(),
});

const ctbcSyncBodySchema = z
  .object({
    verification: z.enum(["check", "email", "restart"]).optional(),
    otp: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
  })
  .refine((value) => !(value.verification && value.otp));

const megabankSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  otp: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
});

const fubonSyncBodySchema = z
  .object({
    captcha: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    otp: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .refine((value) => !(value.captcha && value.otp));

const feibSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

const nextbankSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{1,5}$/)
    .optional(),
});

type ConnectorRuntimeDefinition = {
  run: (
    env: Env,
    trigger: SyncTrigger,
    scope: SyncScope,
    overrides: Record<string, unknown>,
  ) => Promise<SyncOutcome>;
  challenge?: ConnectorChallengeDefinition;
  /** 手動同步可帶的驗證碼／OTP 等接續參數；沒有接續參數的來源省略，route 不讀取 body。 */
  syncBody?: ConnectorSyncBodyDefinition;
  /** 電子發票與集保使用 Queue 分段同步，手動同步路由由 route 個別註冊。 */
  dedicatedSyncRoute?: true;
};

type ConnectorSyncBodyDefinition = {
  schema: z.ZodType<Record<string, unknown>>;
  /** Body 格式不符時回傳的 `INVALID_REQUEST` 訊息。 */
  invalidMessage: string;
};

type ConnectorChallengeDefinition = {
  prepare: (env: Env) => Promise<unknown>;
  /** 準備驗證碼失敗、且錯誤未宣告代碼時回傳的代碼。 */
  failureCode: SyncErrorCode;
};

export const connectorRuntimeRegistry: Record<
  ConnectorId,
  ConnectorRuntimeDefinition
> = {
  einvoice: {
    dedicatedSyncRoute: true,
    run: async () => {
      throw new Error(
        "Electronic invoice sync must be started through its durable Queue flow.",
      );
    },
  },
  tdcc: {
    dedicatedSyncRoute: true,
    run: async () => {
      throw new Error(
        "TDCC sync must be started through its durable Queue flow.",
      );
    },
  },
  esun: {
    run: (env, trigger) => syncEsun(env, trigger),
  },
  cathaybk: {
    run: (env, trigger, _scope, overrides) =>
      syncCathaybk(env, trigger, overrides as CathaySyncOverrides),
    syncBody: {
      schema: cathaySyncBodySchema,
      invalidMessage: "Cathay sync options are invalid.",
    },
  },
  ctbc: {
    run: (env, trigger, _scope, overrides) =>
      syncCtbc(env, trigger, overrides as CtbcSyncOverrides),
    syncBody: {
      schema: ctbcSyncBodySchema,
      invalidMessage: "中國信託驗證選項格式錯誤。",
    },
  },
  skbank: {
    run: (env, trigger) => syncSkbank(env, trigger),
  },
  sinopac: {
    run: (env, trigger, _scope, overrides) =>
      syncSinopac(env, trigger, overrides as SinopacSyncOverrides),
    syncBody: {
      schema: sinopacSyncBodySchema,
      invalidMessage: "Sinopac sync options are invalid.",
    },
    challenge: {
      prepare: prepareSinopacCaptchaSession,
      failureCode: "SINOPAC_CAPTCHA_FAILED",
    },
  },
  taishin: {
    run: (env, trigger, _scope, overrides) =>
      syncTaishin(env, trigger, overrides as TaishinSyncOverrides),
    syncBody: {
      schema: taishinSyncBodySchema,
      invalidMessage: "Taishin sync options are invalid.",
    },
    challenge: {
      prepare: prepareTaishinCaptchaSession,
      failureCode: "TAISHIN_CONNECTION_FAILED",
    },
  },
  hncb: {
    run: (env, trigger, _scope, overrides) =>
      syncHncb(env, trigger, overrides as HncbSyncOverrides),
    syncBody: {
      schema: hncbSyncBodySchema,
      invalidMessage: "HNCB sync options are invalid.",
    },
    challenge: {
      prepare: prepareHncbCaptchaSession,
      failureCode: "HNCB_CAPTCHA_FAILED",
    },
  },
  obank: {
    run: (env, trigger, _scope, overrides) =>
      syncObank(env, trigger, overrides as ObankSyncOverrides),
    syncBody: {
      schema: obankSyncBodySchema,
      invalidMessage: "O-Bank sync options are invalid.",
    },
    challenge: {
      prepare: prepareObankCaptchaSession,
      failureCode: "OBANK_CAPTCHA_FAILED",
    },
  },
  nextbank: {
    run: (env, trigger, _scope, overrides) =>
      syncNextbank(env, trigger, overrides),
    syncBody: {
      schema: nextbankSyncBodySchema,
      invalidMessage: "將來銀行驗證碼格式不符。",
    },
    challenge: {
      prepare: prepareNextbankCaptchaSession,
      failureCode: "NEXTBANK_CAPTCHA_FAILED",
    },
  },
  firstbank: {
    run: (env, trigger, _scope, overrides) =>
      syncFirstbank(env, trigger, overrides as FirstbankSyncOverrides),
    syncBody: {
      schema: firstbankSyncBodySchema,
      invalidMessage: "第一銀行 sync options are invalid.",
    },
    challenge: {
      prepare: prepareFirstbankCaptchaSession,
      failureCode: "FIRSTBANK_CAPTCHA_FAILED",
    },
  },
  rakuten: {
    run: (env, trigger, _scope, overrides) =>
      syncRakuten(env, trigger, overrides as RakutenSyncOverrides),
    syncBody: {
      schema: rakutenSyncBodySchema,
      invalidMessage: "Rakuten sync options are invalid.",
    },
    challenge: {
      prepare: prepareRakutenCaptchaSession,
      failureCode: "RAKUTEN_CAPTCHA_FAILED",
    },
  },
  kgibank: {
    run: (env, trigger, _scope, overrides) =>
      syncKgibank(env, trigger, overrides as KgibankSyncOverrides),
    syncBody: {
      schema: kgibankSyncBodySchema,
      invalidMessage: "KGI Bank sync options are invalid.",
    },
    challenge: {
      prepare: prepareKgibankCaptchaSession,
      failureCode: "KGIBANK_CAPTCHA_FAILED",
    },
  },
  megabank: {
    run: (env, trigger, _scope, overrides) =>
      syncMegabank(env, trigger, overrides as MegabankSyncOverrides),
    syncBody: {
      schema: megabankSyncBodySchema,
      invalidMessage: "兆豐銀行同步選項格式錯誤。",
    },
    challenge: {
      prepare: prepareMegabankCaptchaSession,
      failureCode: "MEGABANK_CAPTCHA_FAILED",
    },
  },
  fubon: {
    run: (env, trigger, _scope, overrides) =>
      syncFubon(env, trigger, overrides as FubonSyncOverrides),
    syncBody: {
      schema: fubonSyncBodySchema,
      invalidMessage: "台北富邦銀行同步選項格式錯誤。",
    },
    challenge: {
      prepare: prepareFubonCaptchaSession,
      failureCode: "FUBON_CAPTCHA_FAILED",
    },
  },
  feib: {
    run: (env, trigger, _scope, overrides) =>
      syncFeib(env, trigger, overrides as FeibSyncOverrides),
    syncBody: {
      schema: feibSyncBodySchema,
      invalidMessage: "遠東商銀同步選項格式錯誤。",
    },
    challenge: {
      prepare: prepareFeibCaptchaSession,
      failureCode: "FEIB_CAPTCHA_FAILED",
    },
  },
  ubot: {
    run: (env, trigger) => syncUbot(env, trigger),
  },
};

export function runConnectorSync(
  env: Env,
  connectorId: ConnectorId,
  trigger: SyncTrigger,
  scope: SyncScope = SYNC_SCOPE_ALL,
  overrides: Record<string, unknown> = {},
) {
  const supportedScopes: readonly string[] =
    connectorCatalog[connectorId].scopes;
  if (!supportedScopes.includes(scope)) {
    throw new Error(`${connectorId} sync scope is not supported: ${scope}`);
  }
  return connectorRuntimeRegistry[connectorId].run(
    env,
    trigger,
    scope,
    overrides,
  );
}

/** 使用一般手動同步路由的來源；route 依此註冊 `/connectors/:id/sync`。 */
export const manualSyncConnectorIds = (
  Object.keys(connectorRuntimeRegistry) as ConnectorId[]
).filter(
  (connectorId) => !connectorRuntimeRegistry[connectorId].dedicatedSyncRoute,
);

export function manualSyncBody(connectorId: ConnectorId) {
  return connectorRuntimeRegistry[connectorId].syncBody;
}

/** 有互動驗證碼流程的來源；route 依此註冊 `/connectors/:id/captcha`。 */
export const challengeConnectorIds = (
  Object.keys(connectorRuntimeRegistry) as ConnectorId[]
).filter((connectorId) => connectorRuntimeRegistry[connectorId].challenge);

export function prepareConnectorChallenge(env: Env, connectorId: ConnectorId) {
  const challenge = connectorRuntimeRegistry[connectorId].challenge;
  if (!challenge) {
    throw new Error(
      `${connectorId} does not support an interactive challenge.`,
    );
  }
  return challenge.prepare(env);
}

export function challengeFailureCode(connectorId: ConnectorId): SyncErrorCode {
  return (
    connectorRuntimeRegistry[connectorId].challenge?.failureCode ??
    "SYNC_FAILED"
  );
}
