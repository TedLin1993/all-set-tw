import type { InvestmentRow } from "@/data/investments/types";
import { formatNumber } from "@/shared/format/financial";

/** 加密貨幣數量常小於 1，保留到交易所常見的 8 位小數；其他持倉維持整數顯示。 */
export function formatPositionQuantity(
  position: Pick<InvestmentRow, "assetType" | "quantity">,
) {
  if (position.quantity == null) return "-";
  if (position.assetType !== "crypto") return formatNumber(position.quantity);
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 8 }).format(
    position.quantity,
  );
}

export function positionAssetTypeLabel(assetType: InvestmentRow["assetType"]) {
  return assetType === "crypto" ? "加密貨幣" : assetType.toUpperCase();
}
