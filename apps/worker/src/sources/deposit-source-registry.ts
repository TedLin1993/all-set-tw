import {
  connectorCatalog,
  isConnectorId,
  type ConnectorId,
} from "@taiwan-fin-hub/shared";
import { obankDepositAccountFromSourceId } from "./obank/protocol";

/** Catalog 宣告 `bankCode` 的資料來源，即直接提供自家存款帳戶的銀行。 */
export type BankConnectorId = {
  [K in ConnectorId]: (typeof connectorCatalog)[K]["bankCode"] extends string
    ? K
    : never;
}[ConnectorId];

/**
 * 直接存款 sourceId 約定為 `bank:<connectorId>:<帳號或末四碼>:...`，預設取第三段。
 * 不符合約定的來源在此註冊自家 protocol 的解析；傳入的 sourceId 已確認以 `bank:<connectorId>:` 開頭。
 */
const depositAccountOverrides: Partial<
  Record<BankConnectorId, (sourceId: string) => string>
> = {
  obank: obankDepositAccountFromSourceId,
};

function isBankConnectorId(value: string): value is BankConnectorId {
  return isConnectorId(value) && connectorCatalog[value].bankCode !== null;
}

/** 直接存款來源；其他來源（例如集保交割帳戶）依銀行代碼與末四碼連結到這些帳戶。 */
export const bankConnectorIds: readonly BankConnectorId[] =
  Object.keys(connectorCatalog).filter(isBankConnectorId);

/** 解析直接存款來源的 sourceId；不是 `bank:<直接存款來源>:` 格式時回傳 `undefined`。 */
export function parseDepositSourceId(sourceId: string) {
  const connectorId = sourceId.match(/^bank:([^:]+):/)?.[1];
  if (!connectorId || !isBankConnectorId(connectorId)) return undefined;
  const parseOverride = depositAccountOverrides[connectorId];
  return {
    connectorId,
    bankCode: connectorCatalog[connectorId].bankCode,
    account: parseOverride
      ? parseOverride(sourceId)
      : (sourceId.split(":")[2] ?? ""),
  };
}
