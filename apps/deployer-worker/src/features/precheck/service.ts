import type { Env, PublicSession } from "../../platform/env";
import {
  listAuthorizedAccounts,
  runAccountPrecheck,
} from "../../platform/cloudflare";
import { readAccessToken } from "../auth/service";

export const WORKER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export class AccountNotAuthorizedError extends Error {
  constructor() {
    super("ACCOUNT_NOT_AUTHORIZED");
    this.name = "AccountNotAuthorizedError";
  }
}

export async function precheckSelectedAccount(
  env: Env,
  session: PublicSession,
  input: { accountId: string; workerName: string },
) {
  if (session.selectedAccountId !== input.accountId) {
    throw new AccountNotAuthorizedError();
  }
  const { accessToken } = await readAccessToken(env, session.id);
  const accounts = await listAuthorizedAccounts(accessToken);
  if (!accounts.some((account) => account.id === input.accountId)) {
    throw new AccountNotAuthorizedError();
  }
  const result = await runAccountPrecheck({
    accessToken,
    accountId: input.accountId,
    workerName: input.workerName,
  });
  return {
    accountId: input.accountId,
    workerName: input.workerName,
    ...result,
  };
}
