import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/shared";
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
  prepareChallenge?: (env: Env) => Promise<unknown>;
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
    prepareChallenge: prepareSinopacCaptchaSession,
  },
  taishin: {
    run: (env, trigger, _scope, overrides) =>
      syncTaishin(env, trigger, overrides as TaishinSyncOverrides),
    prepareChallenge: prepareTaishinCaptchaSession,
  },
  hncb: {
    run: (env, trigger, _scope, overrides) =>
      syncHncb(env, trigger, overrides as HncbSyncOverrides),
    prepareChallenge: prepareHncbCaptchaSession,
  },
  obank: {
    run: (env, trigger, _scope, overrides) =>
      syncObank(env, trigger, overrides as ObankSyncOverrides),
    prepareChallenge: prepareObankCaptchaSession,
  },
  nextbank: {
    run: (env, trigger, _scope, overrides) =>
      syncNextbank(env, trigger, overrides),
    prepareChallenge: prepareNextbankCaptchaSession,
  },
  firstbank: {
    run: (env, trigger, _scope, overrides) =>
      syncFirstbank(env, trigger, overrides as FirstbankSyncOverrides),
    prepareChallenge: prepareFirstbankCaptchaSession,
  },
  rakuten: {
    run: (env, trigger, _scope, overrides) =>
      syncRakuten(env, trigger, overrides as RakutenSyncOverrides),
    prepareChallenge: prepareRakutenCaptchaSession,
  },
  kgibank: {
    run: (env, trigger, _scope, overrides) =>
      syncKgibank(env, trigger, overrides as KgibankSyncOverrides),
    prepareChallenge: prepareKgibankCaptchaSession,
  },
  megabank: {
    run: (env, trigger, _scope, overrides) =>
      syncMegabank(env, trigger, overrides as MegabankSyncOverrides),
    prepareChallenge: prepareMegabankCaptchaSession,
  },
  fubon: {
    run: (env, trigger, _scope, overrides) =>
      syncFubon(env, trigger, overrides as FubonSyncOverrides),
    prepareChallenge: prepareFubonCaptchaSession,
  },
  feib: {
    run: (env, trigger, _scope, overrides) =>
      syncFeib(env, trigger, overrides as FeibSyncOverrides),
    prepareChallenge: prepareFeibCaptchaSession,
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

export function prepareConnectorChallenge(env: Env, connectorId: ConnectorId) {
  const prepare = connectorRuntimeRegistry[connectorId].prepareChallenge;
  if (!prepare) {
    throw new Error(
      `${connectorId} does not support an interactive challenge.`,
    );
  }
  return prepare(env);
}
