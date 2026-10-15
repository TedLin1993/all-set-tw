import type { ConnectorId } from "@taiwan-fin-hub/shared";
import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
  InvestmentTransaction,
  InvoiceLineItem,
  NetWorthHistoryPoint,
} from "./financial-types";

export interface SyncResult<TResult> {
  records: TResult[];
  cursor?: string;
  invoiceLineItems?: Array<
    Omit<InvoiceLineItem, "id" | "connectorId" | "invoiceId">
  >;
  bankAccounts?: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots?: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions?: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills?: Array<Omit<CreditCardBill, "id" | "connectorId">>;
  investmentTransactions?: Array<
    Omit<InvestmentTransaction, "id" | "connectorId">
  >;
  netWorthHistory?: NetWorthHistoryPoint[];
}

export interface Connector<TConfig, TResult> {
  id: ConnectorId;
  name: string;
  sync(config: TConfig, cursor?: string): Promise<SyncResult<TResult>>;
}
