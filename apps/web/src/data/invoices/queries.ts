import { queryOptions } from "@tanstack/svelte-query";
import type { CreateQueryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";
import type { MonthRange } from "@/shared/date-range";
import type {
  InvoiceRow,
  InvoiceSummaryRow,
  InvoiceTransactionPreference,
} from "./types";

type ApiProvider = () => ApiClient;

export const invoicesRangeQuery = (getApi: ApiProvider, range: MonthRange) =>
  queryOptions({
    queryKey: queryKeys.invoicesRange(range.from, range.to),
    queryFn: () =>
      getApi().get<InvoiceSummaryRow[]>(
        `/api/invoices?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
  });

export const invoicesQuery = (
  getApi: ApiProvider,
  range?: MonthRange,
): CreateQueryOptions<InvoiceSummaryRow[]> => ({
  queryKey: range
    ? queryKeys.invoicesRange(range.from, range.to)
    : queryKeys.invoices,
  queryFn: () =>
    getApi().get<InvoiceSummaryRow[]>(
      range
        ? `/api/invoices?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
        : "/api/invoices",
    ),
});

export const invoiceDetailQuery = (
  getApi: ApiProvider,
  invoiceId: string | null,
) =>
  queryOptions({
    queryKey: queryKeys.invoiceDetail(invoiceId ?? ""),
    queryFn: () =>
      getApi().get<InvoiceRow>(
        `/api/invoices/${encodeURIComponent(invoiceId ?? "")}`,
      ),
    enabled: Boolean(invoiceId),
  });

export const invoiceTransactionMappingsQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.invoiceTransactionMappings,
    queryFn: () =>
      getApi().get<InvoiceTransactionPreference[]>(
        "/api/activity/invoice-mappings",
      ),
  });
