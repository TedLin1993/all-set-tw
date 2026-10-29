import type { ConnectorId } from "@taiwan-fin-hub/shared";

export type { InvoiceTransactionPreference } from "@taiwan-fin-hub/shared";

export interface InvoiceLineItemRow {
  id: string;
  invoiceId?: string;
  sourceId: string;
  lineNumber: number;
  description: string;
  quantity?: number;
  unitPrice?: number;
  amount: number;
}

export interface InvoiceSummaryRow {
  id: string;
  connectorId: ConnectorId;
  sourceId: string;
  invoiceDate: string;
  invoiceNumber?: string;
  sellerName?: string;
  amount: number;
  /** 純發票活動是否排除於收支計算；配對交易後不使用。 */
  excludedFromCalculation?: boolean;
}

export interface InvoiceRow extends InvoiceSummaryRow {
  items: InvoiceLineItemRow[];
}
