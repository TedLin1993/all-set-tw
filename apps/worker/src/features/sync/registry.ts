import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/core";
import type { SyncTrigger } from "@taiwan-fin-hub/db";
import type { Env } from "../../platform/env";
import {
  prepareSinopacCaptchaSession,
  prepareTaishinCaptchaSession,
  prepareObankCaptchaSession,
  syncCathaybk,
  syncCtbc,
  syncEsun,
  syncSinopac,
  syncObank,
  syncTaishin,
  syncTdcc,
  SYNC_SCOPE_ALL,
  TDCC_SCOPE_BANK,
  TDCC_SCOPE_INVESTMENTS,
  TDCC_SCOPE_TRADES,
  type SinopacSyncOverrides,
  type ObankSyncOverrides,
  type SyncOutcome,
  type SyncScope,
  type TaishinSyncOverrides,
  type TdccSyncOverrides,
} from "./service";

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
    run: (env, trigger, scope, overrides) =>
      syncTdcc(
        env,
        trigger,
        overrides as TdccSyncOverrides,
        scope === SYNC_SCOPE_ALL ? tdccAllScopes() : [scope],
      ),
  },
  esun: {
    run: (env, trigger) => syncEsun(env, trigger),
  },
  cathaybk: {
    run: (env, trigger) => syncCathaybk(env, trigger),
  },
  ctbc: {
    run: (env, trigger) => syncCtbc(env, trigger),
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
  obank: {
    run: (env, trigger, _scope, overrides) =>
      syncObank(env, trigger, overrides as ObankSyncOverrides),
    prepareChallenge: prepareObankCaptchaSession,
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

function tdccAllScopes(): SyncScope[] {
  return [TDCC_SCOPE_INVESTMENTS, TDCC_SCOPE_BANK, TDCC_SCOPE_TRADES];
}
