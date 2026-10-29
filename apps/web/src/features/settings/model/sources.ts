import {
  Bitcoin,
  ChartCandlestick,
  Landmark,
  ReceiptText,
} from "@lucide/svelte";
import type {
  ConnectorCapability,
  connectorList,
} from "@taiwan-fin-hub/shared";
import { getSyncSourceStatus } from "@/data/connectors/sync-status";
import type { ConnectorId, SyncJobRow } from "@/data/connectors/types";

export type ConnectorSource = (typeof connectorList)[number];

/**
 * 支援範圍標籤的顯示順序與文字。交易明細、餘額快照與淨值歷史是多數來源共有的
 * 附帶資料，不另列標籤，只保留能區分來源差異的項目。
 */
const capabilityTags: Partial<Record<ConnectorCapability, string>> = {
  invoice: "發票",
  invoice_line_item: "品項明細",
  investment_position: "持倉",
  investment_transaction: "投資交易",
  bank_account: "存款",
  credit_card_bill: "信用卡",
  loan: "貸款",
};

export function sourceCapabilitySummary(source: ConnectorSource) {
  const capabilities: readonly ConnectorCapability[] = source.capabilities;
  return Object.entries(capabilityTags)
    .filter(([capability]) =>
      capabilities.includes(capability as ConnectorCapability),
    )
    .map(([, label]) => label)
    .join("・");
}

/** 加密貨幣交易所來源；新增資料來源選擇器將其獨立成一組，並使用比特幣圖示。 */
export function isCryptoSource(id: ConnectorId) {
  return id === "binance" || id === "max";
}

export function sourceIcon(id: ConnectorId) {
  return id === "einvoice"
    ? ReceiptText
    : id === "tdcc"
      ? ChartCandlestick
      : isCryptoSource(id)
        ? Bitcoin
        : Landmark;
}

/**
 * 依同步狀態把資料來源分成需要處理、已連接（含等待首次同步）與尚未設定三組，
 * 各組維持 catalog 順序，與同步報告的來源排序一致。
 */
export function groupSourcesByStatus(
  sources: readonly ConnectorSource[],
  jobs: SyncJobRow[],
) {
  const jobById = new Map(
    jobs
      .filter((job) => job.scope === "all")
      .map((job) => [job.connectorId, job]),
  );
  const groups = {
    actionable: [] as ConnectorSource[],
    connected: [] as ConnectorSource[],
    available: [] as ConnectorSource[],
    jobById,
  };
  for (const source of sources) {
    const status = getSyncSourceStatus(jobById.get(source.id));
    if (status === "needs_action") groups.actionable.push(source);
    else if (status === "unconfigured") groups.available.push(source);
    else groups.connected.push(source);
  }
  return groups;
}

/** 新增資料來源選擇器的分組：發票與證券在前，銀行居中，使用較少的加密貨幣放最後。 */
export function isBankSource(source: ConnectorSource) {
  const capabilities: readonly string[] = source.capabilities;
  return (
    !capabilities.includes("invoice") &&
    !capabilities.includes("investment_position")
  );
}
