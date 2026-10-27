import type { ConnectorId } from "@taiwan-fin-hub/shared";
import type { CryptoHoldings } from "../../sources/crypto-holdings";
import { requireConnectorSettings } from "./config";
import { connectorSettingsGuardStatement } from "./connector-repository";
import { NeedsUserActionError } from "./errors";
import { persistStagedSyncWrite, type SyncWriteRecord } from "./persistence";
import {
  investmentPositionRecord,
  netWorthHistoryRecord,
} from "./record-mapper";

/** 刪除同一來源同一天的持倉快照，讓當天賣出的幣種在重新同步後消失。 */
function replaceSameDayInvestmentPositionsStatement(
  db: D1Database,
  connectorId: ConnectorId,
  asOfDate: string,
) {
  return db
    .prepare(
      "DELETE FROM investment_positions WHERE connector_id = ? AND as_of_date = ?",
    )
    .bind(connectorId, asOfDate);
}

/**
 * 加密貨幣交易所的持倉以「當天完整快照」寫入：設定版本 guard、刪除當天舊列、
 * promotion 新列與淨資產歷史在同一個 D1 batch；任何一步失敗都整批回滾。
 * `holdings.positions` 至少有一列（無持倉時為零值列），因此最新日期一定是今天。
 */
export async function persistCryptoHoldings(
  db: D1Database,
  input: {
    connectorId: ConnectorId;
    title: string;
    encryptedConfig: string;
    settingsUpdatedAt: string;
    holdings: CryptoHoldings;
    now: string;
  },
) {
  const { connectorId, holdings, now } = input;
  const records: SyncWriteRecord[] = [
    ...holdings.positions.map((position) =>
      investmentPositionRecord(connectorId, position, now),
    ),
    netWorthHistoryRecord(connectorId, holdings.netWorth, now),
  ];
  return persistStagedSyncWrite(db, {
    records,
    beforePromoteStatements: [
      connectorSettingsGuardStatement(
        db,
        connectorId,
        input.encryptedConfig,
        input.settingsUpdatedAt,
      ),
      replaceSameDayInvestmentPositionsStatement(
        db,
        connectorId,
        holdings.netWorth.date,
      ),
    ],
  }).catch(async (error) => {
    const current = await requireConnectorSettings(db, connectorId);
    if (
      current.encrypted_config !== input.encryptedConfig ||
      current.updated_at !== input.settingsUpdatedAt
    ) {
      throw new NeedsUserActionError(
        `${input.title} 設定在同步期間已變更，請重新同步。`,
      );
    }
    throw error;
  });
}
