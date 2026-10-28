import {
  EMPTY_INVESTMENT_SOURCE_ID,
  INVESTMENT_DUST_THRESHOLD_TWD,
  connectorCatalog,
  type ConnectorId,
} from "@taiwan-fin-hub/shared";
import type { InvestmentRow } from "@/data/investments/types";

export type InvestmentHolding = {
  row: InvestmentRow;
  /** 換算台幣後的市值；沒有市值或缺少匯率時為 null。 */
  valueTwd: number | null;
};

type InvestmentInstitution = {
  key: string;
  label: string;
  /** 已排除小額與無持倉列，依台幣市值由大到小排序。 */
  holdings: InvestmentHolding[];
  totalTwd: number;
  visibleCount: number;
  hiddenCount: number;
};

function institutionLabel(connectorId: string) {
  return connectorCatalog[connectorId as ConnectorId]?.title ?? connectorId;
}

function holdingValueTwd(
  row: InvestmentRow,
  rates: Readonly<Record<string, number>>,
): number | null {
  if (row.marketValue == null && row.cashBalance == null) return null;
  const value = (row.marketValue ?? 0) + (row.cashBalance ?? 0);
  if (row.currency === "TWD") return value;
  const rate = rates[row.currency];
  return rate ? value * rate : null;
}

function compareHoldings(left: InvestmentHolding, right: InvestmentHolding) {
  if (left.valueTwd === null || right.valueTwd === null) {
    if (left.valueTwd !== right.valueTwd)
      return left.valueTwd === null ? 1 : -1;
  } else if (left.valueTwd !== right.valueTwd) {
    return right.valueTwd - left.valueTwd;
  }
  return `${left.row.symbol ?? ""}${left.row.name}`.localeCompare(
    `${right.row.symbol ?? ""}${right.row.name}`,
  );
}

function isHidden(holding: InvestmentHolding) {
  return (
    holding.valueTwd !== null &&
    Math.abs(holding.valueTwd) < INVESTMENT_DUST_THRESHOLD_TWD
  );
}

/**
 * 依資料來源分機構，機構內持倉平鋪並依台幣市值由大到小排序。
 * 小額持倉不列出但計入小計；無法估值的持倉照樣列出、排在最後。
 */
export function groupInvestmentPositions(
  rows: readonly InvestmentRow[],
  rates: Readonly<Record<string, number>>,
): InvestmentInstitution[] {
  const institutions = new Map<string, InvestmentHolding[]>();
  for (const row of rows) {
    const key = row.connectorId ?? "unknown";
    const holdings = institutions.get(key) ?? [];
    institutions.set(key, holdings);
    if (row.sourceId === EMPTY_INVESTMENT_SOURCE_ID) continue;
    holdings.push({ row, valueTwd: holdingValueTwd(row, rates) });
  }

  return [...institutions]
    .map(([key, holdings]): InvestmentInstitution => {
      const sorted = holdings.slice().sort(compareHoldings);
      const visible = sorted.filter((holding) => !isHidden(holding));
      return {
        key,
        label: institutionLabel(key),
        holdings: visible,
        totalTwd: sorted.reduce(
          (sum, holding) => sum + (holding.valueTwd ?? 0),
          0,
        ),
        visibleCount: visible.length,
        hiddenCount: sorted.length - visible.length,
      };
    })
    .sort(
      (left, right) =>
        right.totalTwd - left.totalTwd || left.label.localeCompare(right.label),
    );
}

/** 加密貨幣在資產頁與總覽是獨立大類，與集保等證券投資分開（含交易所無持倉的零值列）。 */
export function isCryptoPosition(row: InvestmentRow) {
  return row.assetType === "crypto";
}

/** 不分機構的持倉清單：套用與分組相同的排序與小額隱藏規則。 */
export function listInvestmentHoldings(
  rows: readonly InvestmentRow[],
  rates: Readonly<Record<string, number>>,
) {
  const groups = groupInvestmentPositions(rows, rates);
  return {
    holdings: groups.flatMap((group) => group.holdings).sort(compareHoldings),
    hiddenCount: groups.reduce((sum, group) => sum + group.hiddenCount, 0),
  };
}

/** 實際列出的持倉筆數（不含小額與無持倉列），與分組畫面一致。 */
export function listedHoldingCount(
  rows: readonly InvestmentRow[],
  rates: Readonly<Record<string, number>>,
) {
  return groupInvestmentPositions(rows, rates).reduce(
    (sum, institution) => sum + institution.visibleCount,
    0,
  );
}

const FUTURES_TITLES: Record<string, string> = {
  "futures-usdm": "U 本位",
  "futures-coinm": "幣本位",
};

/** 持倉名稱：加密貨幣已在交易所分組下，只顯示幣種代碼或合約類型。 */
export function holdingTitle(row: InvestmentRow) {
  const futures = FUTURES_TITLES[row.sourceId];
  if (row.assetType === "crypto" && futures) return futures;
  if (row.assetType === "crypto" && row.symbol) {
    return (row.quantity ?? 0) < 0 ? `${row.symbol} 借款` : row.symbol;
  }
  return row.symbol ? `${row.symbol} ${row.name}` : row.name;
}
