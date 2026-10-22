import {
  connectorCatalog,
  type ConnectorId,
  type SyncErrorCode,
} from "@taiwan-fin-hub/shared";
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
import { syncEsun } from "../../sources/esun/sync";
import {
  syncNextbank,
  prepareNextbankCaptchaSession,
} from "../../sources/nextbank/sync";
import { SYNC_SCOPE_ALL, type SyncOutcome, type SyncScope } from "./types";

type ConnectorRuntimeDefinition = {
  run: (
    env: Env,
    trigger: SyncTrigger,
    scope: SyncScope,
    overrides: Record<string, unknown>,
  ) => Promise<SyncOutcome>;
  challenge?: ConnectorChallengeDefinition;
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
    run: async () => {
      throw new Error(
        "Electronic invoice sync must be started through its durable Queue flow.",
      );
    },
  },
  tdcc: {
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
  },
  ctbc: {
    run: (env, trigger, _scope, overrides) =>
      syncCtbc(env, trigger, overrides as CtbcSyncOverrides),
  },
  skbank: {
    run: (env, trigger) => syncSkbank(env, trigger),
  },
  sinopac: {
    run: (env, trigger, _scope, overrides) =>
      syncSinopac(env, trigger, overrides as SinopacSyncOverrides),
    challenge: {
      prepare: prepareSinopacCaptchaSession,
      failureCode: "SINOPAC_CAPTCHA_FAILED",
    },
  },
  taishin: {
    run: (env, trigger, _scope, overrides) =>
      syncTaishin(env, trigger, overrides as TaishinSyncOverrides),
    challenge: {
      prepare: prepareTaishinCaptchaSession,
      failureCode: "TAISHIN_CONNECTION_FAILED",
    },
  },
  hncb: {
    run: (env, trigger, _scope, overrides) =>
      syncHncb(env, trigger, overrides as HncbSyncOverrides),
    challenge: {
      prepare: prepareHncbCaptchaSession,
      failureCode: "HNCB_CAPTCHA_FAILED",
    },
  },
  obank: {
    run: (env, trigger, _scope, overrides) =>
      syncObank(env, trigger, overrides as ObankSyncOverrides),
    challenge: {
      prepare: prepareObankCaptchaSession,
      failureCode: "OBANK_CAPTCHA_FAILED",
    },
  },
  nextbank: {
    run: (env, trigger, _scope, overrides) =>
      syncNextbank(env, trigger, overrides),
    challenge: {
      prepare: prepareNextbankCaptchaSession,
      failureCode: "NEXTBANK_CAPTCHA_FAILED",
    },
  },
  firstbank: {
    run: (env, trigger, _scope, overrides) =>
      syncFirstbank(env, trigger, overrides as FirstbankSyncOverrides),
    challenge: {
      prepare: prepareFirstbankCaptchaSession,
      failureCode: "FIRSTBANK_CAPTCHA_FAILED",
    },
  },
  rakuten: {
    run: (env, trigger, _scope, overrides) =>
      syncRakuten(env, trigger, overrides as RakutenSyncOverrides),
    challenge: {
      prepare: prepareRakutenCaptchaSession,
      failureCode: "RAKUTEN_CAPTCHA_FAILED",
    },
  },
  kgibank: {
    run: (env, trigger, _scope, overrides) =>
      syncKgibank(env, trigger, overrides as KgibankSyncOverrides),
    challenge: {
      prepare: prepareKgibankCaptchaSession,
      failureCode: "KGIBANK_CAPTCHA_FAILED",
    },
  },
  megabank: {
    run: (env, trigger, _scope, overrides) =>
      syncMegabank(env, trigger, overrides as MegabankSyncOverrides),
    challenge: {
      prepare: prepareMegabankCaptchaSession,
      failureCode: "MEGABANK_CAPTCHA_FAILED",
    },
  },
  fubon: {
    run: (env, trigger, _scope, overrides) =>
      syncFubon(env, trigger, overrides as FubonSyncOverrides),
    challenge: {
      prepare: prepareFubonCaptchaSession,
      failureCode: "FUBON_CAPTCHA_FAILED",
    },
  },
  feib: {
    run: (env, trigger, _scope, overrides) =>
      syncFeib(env, trigger, overrides as FeibSyncOverrides),
    challenge: {
      prepare: prepareFeibCaptchaSession,
      failureCode: "FEIB_CAPTCHA_FAILED",
    },
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
