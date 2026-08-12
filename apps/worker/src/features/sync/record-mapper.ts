import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  ConnectorId,
  CreditCardBill,
  InvestmentPosition,
  InvestmentTransaction,
  Invoice,
  InvoiceLineItem,
  NetWorthHistoryPoint,
} from "@taiwan-fin-hub/core";
import { deriveBankMatchKey } from "../bank/display";
import type { SyncWriteRecord } from "./persistence";

function stableId(...parts: string[]) {
  return parts.join(":");
}

export function invoiceRecord(
  connectorId: ConnectorId,
  invoice: Omit<Invoice, "id" | "connectorId">,
  now: string,
): SyncWriteRecord {
  const id = stableId(connectorId, invoice.sourceId);
  return {
    entityType: "invoice",
    recordKey: id,
    payload: {
      id,
      connector_id: connectorId,
      source_id: invoice.sourceId,
      invoice_number: invoice.invoiceNumber ?? null,
      invoice_date: invoice.invoiceDate,
      seller_name: invoice.sellerName ?? null,
      amount: invoice.amount,
      raw_payload: JSON.stringify(invoice.raw ?? invoice),
      created_at: now,
      updated_at: now,
    },
  };
}

export function invoiceLineItemRecord(
  connectorId: ConnectorId,
  item: Omit<InvoiceLineItem, "id" | "connectorId" | "invoiceId">,
  now: string,
): SyncWriteRecord {
  const invoiceId = stableId(connectorId, item.invoiceSourceId);
  const id = stableId(connectorId, item.invoiceSourceId, "item", item.sourceId);
  return {
    entityType: "invoice_line_item",
    recordKey: id,
    payload: {
      id,
      invoice_id: invoiceId,
      connector_id: connectorId,
      invoice_source_id: item.invoiceSourceId,
      source_id: item.sourceId,
      line_number: item.lineNumber,
      description: item.description,
      quantity: item.quantity ?? null,
      unit_price: item.unitPrice ?? null,
      amount: item.amount,
      raw_payload: JSON.stringify(item.raw ?? item),
      created_at: now,
      updated_at: now,
    },
  };
}

export function bankAccountRecord(
  connectorId: ConnectorId,
  account: Omit<BankAccount, "id" | "connectorId">,
  now: string,
): SyncWriteRecord {
  const { bankCode, last4 } = deriveBankMatchKey(connectorId, account.sourceId);
  const id = stableId(connectorId, account.sourceId);
  return {
    entityType: "bank_account",
    recordKey: id,
    payload: {
      id,
      connector_id: connectorId,
      source_id: account.sourceId,
      institution_name: account.institutionName ?? null,
      account_name: account.accountName ?? null,
      account_type: account.accountType ?? null,
      currency: account.currency || "TWD",
      credit_limit: account.creditLimit ?? null,
      bank_code: bankCode,
      account_last4: last4,
      raw_payload: JSON.stringify(account.raw ?? account),
      created_at: now,
      updated_at: now,
    },
  };
}

export function bankBalanceSnapshotRecord(
  connectorId: ConnectorId,
  snapshot: Omit<BankBalanceSnapshot, "id" | "connectorId">,
  now: string,
): SyncWriteRecord {
  const accountId = stableId(connectorId, snapshot.accountId);
  const id = stableId(connectorId, snapshot.accountId, snapshot.sourceId);
  return {
    entityType: "bank_balance_snapshot",
    recordKey: id,
    payload: {
      id,
      connector_id: connectorId,
      account_id: accountId,
      source_id: snapshot.sourceId,
      balance: snapshot.balance,
      available_balance: snapshot.availableBalance ?? null,
      statement_balance: snapshot.statementBalance ?? null,
      payment_due_date: snapshot.paymentDueDate ?? null,
      statement_closing_date: snapshot.statementClosingDate ?? null,
      no_payment_needed:
        snapshot.noPaymentNeeded == null
          ? null
          : snapshot.noPaymentNeeded
            ? 1
            : 0,
      currency: snapshot.currency || "TWD",
      as_of_at: snapshot.asOfAt,
      raw_payload: JSON.stringify(snapshot.raw ?? snapshot),
      created_at: now,
      updated_at: now,
    },
  };
}

export function bankTransactionRecord(
  connectorId: ConnectorId,
  transaction: Omit<BankTransaction, "id" | "connectorId">,
  now: string,
): SyncWriteRecord {
  const accountId = stableId(connectorId, transaction.accountId);
  const id = stableId(connectorId, transaction.accountId, transaction.sourceId);
  return {
    entityType: "bank_transaction",
    recordKey: id,
    payload: {
      id,
      connector_id: connectorId,
      account_id: accountId,
      source_id: transaction.sourceId,
      posted_date: transaction.postedDate ?? null,
      authorized_at: transaction.authorizedAt ?? null,
      amount: transaction.amount,
      currency: transaction.currency || "TWD",
      description: transaction.description ?? null,
      counterparty: transaction.counterparty ?? null,
      status: transaction.status ?? "posted",
      raw_payload: JSON.stringify(transaction.raw ?? transaction),
      created_at: now,
      updated_at: now,
    },
  };
}

export function creditCardBillRecord(
  connectorId: ConnectorId,
  bill: Omit<CreditCardBill, "id" | "connectorId">,
  now: string,
): SyncWriteRecord {
  const accountId = stableId(connectorId, bill.accountId);
  const id = stableId(connectorId, bill.accountId, bill.billingPeriod);
  return {
    entityType: "credit_card_bill",
    recordKey: id,
    payload: {
      id,
      connector_id: connectorId,
      account_id: accountId,
      source_id: bill.sourceId,
      billing_period: bill.billingPeriod,
      statement_amount: bill.statementAmount ?? null,
      minimum_payment: bill.minimumPayment ?? null,
      paid_amount: bill.paidAmount ?? null,
      is_paid: bill.isPaid == null ? null : bill.isPaid ? 1 : 0,
      payment_due_date: bill.paymentDueDate ?? null,
      statement_closing_date: bill.statementClosingDate ?? null,
      currency: bill.currency || "TWD",
      raw_payload: JSON.stringify(bill.raw ?? bill),
      created_at: now,
      updated_at: now,
    },
  };
}

export function investmentPositionRecord(
  connectorId: ConnectorId,
  position: Omit<InvestmentPosition, "id" | "connectorId">,
  now: string,
): SyncWriteRecord {
  const normalized = { ...position, currency: position.currency || "TWD" };
  const id = stableId(connectorId, normalized.sourceId, normalized.asOfDate);
  return {
    entityType: "investment_position",
    recordKey: id,
    payload: {
      id,
      connector_id: connectorId,
      source_id: normalized.sourceId,
      asset_type: normalized.assetType,
      symbol: normalized.symbol ?? null,
      name: normalized.name,
      quantity: normalized.quantity ?? null,
      market_value: normalized.marketValue ?? null,
      cash_balance: normalized.cashBalance ?? null,
      currency: normalized.currency,
      as_of_date: normalized.asOfDate,
      raw_payload: JSON.stringify(normalized.raw ?? normalized),
      created_at: now,
      updated_at: now,
    },
  };
}

export function investmentTransactionRecord(
  connectorId: ConnectorId,
  transaction: Omit<InvestmentTransaction, "id" | "connectorId">,
  now: string,
): SyncWriteRecord {
  const id = stableId(connectorId, transaction.accountId, transaction.sourceId);
  return {
    entityType: "investment_transaction",
    recordKey: id,
    payload: {
      id,
      connector_id: connectorId,
      account_id: transaction.accountId,
      source_id: transaction.sourceId,
      broker_no: transaction.brokerNo ?? null,
      broker_account: transaction.brokerAccount ?? null,
      broker_name: transaction.brokerName ?? null,
      symbol: transaction.symbol ?? null,
      name: transaction.name ?? null,
      asset_type: transaction.assetType ?? null,
      trade_date: transaction.tradeDate ?? null,
      posted_date: transaction.postedDate ?? null,
      transaction_code: transaction.transactionCode ?? null,
      transaction_name: transaction.transactionName ?? null,
      quantity: transaction.quantity ?? null,
      price: transaction.price ?? null,
      amount: transaction.amount ?? null,
      currency: transaction.currency || "TWD",
      raw_payload: JSON.stringify(transaction.raw ?? transaction),
      created_at: now,
      updated_at: now,
    },
  };
}

export function netWorthHistoryRecord(
  source: string,
  point: NetWorthHistoryPoint,
  now: string,
): SyncWriteRecord {
  const assetType = point.assetType ?? "total";
  const id = `${source}:${assetType}:${point.date}`;
  return {
    entityType: "net_worth_history",
    recordKey: id,
    payload: {
      id,
      date: point.date,
      net_worth: point.netWorth,
      asset_type: assetType,
      source,
      snapshotted_at: now,
    },
  };
}
