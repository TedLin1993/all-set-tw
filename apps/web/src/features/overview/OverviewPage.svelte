<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import Button from "@/shared/ui/Button.svelte";
  import Badge from "@/shared/ui/Badge.svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import EmptyState from "@/shared/ui/EmptyState.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import {
    exchangeRatesQuery,
    manualAssetsQuery,
    netWorthHistoryQuery,
  } from "@/data/assets/queries";
  import { bankQuery, bankRangeQuery } from "@/data/bank/queries";
  import { syncJobsQuery } from "@/data/connectors/queries";
  import {
    investmentsQuery,
    investmentTransactionsQuery,
  } from "@/data/investments/queries";
  import {
    invoiceTransactionMappingsQuery,
    invoicesQuery,
    invoicesRangeQuery,
  } from "@/data/invoices/queries";
  import { calculateMonthlyActivityTotals } from "@/data/activity/monthly-totals";
  import type { View } from "@/app/types";
  import {
    formatBankAccountName,
    formatCompactTwd,
    formatCurrency,
    formatDate,
    normalizeFinancialDate,
    rateMap,
  } from "@/shared/format/financial";
  import NetWorthHistoryChart from "./components/NetWorthHistoryChart.svelte";

  let { api, navigate }: { api: ApiClient; navigate: (view: View) => void } =
    $props();

  const bank = createQuery(bankQuery(() => api));
  const monthKey = new Date().toISOString().slice(0, 7);
  const currentMonthRange = { from: monthKey, to: monthKey };
  const monthlyBank = createQuery(bankRangeQuery(() => api, currentMonthRange));
  const investments = createQuery(investmentsQuery(() => api));
  const invoices = createQuery(invoicesQuery(() => api));
  const monthlyInvoices = createQuery(
    invoicesRangeQuery(() => api, currentMonthRange),
  );
  const invoiceMappings = createQuery(
    invoiceTransactionMappingsQuery(() => api),
  );
  const trades = createQuery(investmentTransactionsQuery(() => api));
  const manualAssets = createQuery(manualAssetsQuery(() => api));
  const rates = createQuery(exchangeRatesQuery(() => api));
  const jobs = createQuery(syncJobsQuery(() => api));
  const history = createQuery(netWorthHistoryQuery(() => api));

  const bankData = $derived($bank.data ?? { accounts: [], transactions: [] });
  const rateValues = $derived(rateMap($rates.data));
  const toTwd = (value: number, currency: string) =>
    currency === "TWD" ? value : value * (rateValues[currency] ?? 0);
  const deposits = $derived(
    bankData.accounts.filter((account) => account.accountType !== "credit"),
  );
  const cards = $derived(
    bankData.accounts.filter((account) => account.accountType === "credit"),
  );
  const depositTotal = $derived(
    deposits.reduce(
      (sum, account) => sum + toTwd(account.balance ?? 0, account.currency),
      0,
    ),
  );
  const cardDebt = $derived(
    cards.reduce(
      (sum, account) =>
        sum + Math.abs(toTwd(account.balance ?? 0, account.currency)),
      0,
    ),
  );
  const investmentTotal = $derived(
    ($investments.data ?? []).reduce(
      (sum, item) =>
        sum +
        toTwd((item.marketValue ?? 0) + (item.cashBalance ?? 0), item.currency),
      0,
    ),
  );
  const manualTotal = $derived(
    ($manualAssets.data ?? []).reduce(
      (sum, item) => sum + (item.value ?? 0),
      0,
    ),
  );
  const gross = $derived(depositTotal + investmentTotal + manualTotal);
  const netWorth = $derived(gross - cardDebt);
  const pct = (value: number) =>
    gross > 0 ? Math.round((value / gross) * 100) : 0;
  const allocation = $derived([
    {
      label: "投資",
      value: investmentTotal,
      bar: "bg-steel",
      text: "text-steel",
      detail: `${$investments.data?.length ?? 0} 個持倉`,
    },
    {
      label: "存款",
      value: depositTotal,
      bar: "bg-moss",
      text: "text-moss",
      detail: `${deposits.length} 個帳戶`,
    },
    {
      label: "其他",
      value: manualTotal,
      bar: "bg-coral",
      text: "text-coral",
      detail: "保險、房產",
    },
  ]);
  const monthlyTotals = $derived(
    calculateMonthlyActivityTotals(
      $monthlyBank.data ?? { accounts: [], transactions: [] },
      $monthlyInvoices.data ?? [],
      $invoiceMappings.data ?? [],
      rateValues,
    ),
  );
  const monthlyIncome = $derived(monthlyTotals.income);
  const monthlyExpense = $derived(monthlyTotals.expense);
  const unhealthy = $derived(
    ($jobs.data ?? []).filter(
      (job) =>
        job.lastStatus === "failed" || job.lastStatus === "needs_user_action",
    ),
  );
  const sourceCount = $derived(Math.max(($jobs.data ?? []).length, 4));
  const healthyCount = $derived(Math.max(sourceCount - unhealthy.length, 0));
  const accountRows = $derived(bankData.accounts.slice(0, 4));
  const recent = $derived.by(() =>
    [
      ...bankData.transactions.map((transaction) => ({
        id: `bank-${transaction.id}`,
        date: transaction.postedDate ?? transaction.authorizedAt ?? "",
        title:
          transaction.description ?? transaction.counterparty ?? "銀行交易",
        detail: transaction.institutionName ?? "銀行",
        amount: transaction.amount,
        currency: transaction.currency,
      })),
      ...($trades.data ?? []).map((trade) => ({
        id: `trade-${trade.id}`,
        date: normalizeFinancialDate(trade.tradeDate ?? trade.postedDate),
        title: trade.name ?? trade.transactionName ?? "投資交易",
        detail: trade.brokerName ?? "投資",
        amount: trade.price === 1 ? undefined : trade.amount,
        currency: trade.currency,
      })),
      ...($invoices.data ?? []).map((invoice) => ({
        id: `invoice-${invoice.id}`,
        date: invoice.invoiceDate,
        title: invoice.sellerName ?? "電子發票",
        detail: "電子發票",
        amount: -Math.abs(invoice.amount),
        currency: "TWD",
      })),
    ]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 4),
  );
  const missingRates = $derived([
    ...new Set(
      bankData.accounts
        .map((account) => account.currency)
        .filter((currency) => currency !== "TWD" && !rateValues[currency]),
    ),
  ]);
  const loading = $derived(
    $bank.isPending ||
      $monthlyBank.isPending ||
      $monthlyInvoices.isPending ||
      $invoiceMappings.isPending ||
      $investments.isPending ||
      $manualAssets.isPending,
  );
  const failed = $derived(
    $bank.isError ||
      $monthlyBank.isError ||
      $monthlyInvoices.isError ||
      $invoiceMappings.isError ||
      $investments.isError ||
      $manualAssets.isError,
  );
</script>

{#if loading}
  <EmptyState title="載入總覽中" body="正在讀取最新紀錄。" />
{:else if failed}
  <EmptyState
    title="無法載入總覽"
    body="請稍後再試，或確認 Worker API 是否可用。"
  />
{:else}
  <div class="grid min-w-0 gap-4 md:gap-5">
    {#if missingRates.length}
      <div
        class="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
      >
        <span
          >帳戶含外幣（{missingRates.join("、")}）尚未設定匯率，TWD
          總額可能不準確。</span
        >
        <button
          class="shrink-0 font-semibold underline underline-offset-2"
          onclick={() => navigate("settings")}>前往設定</button
        >
      </div>
    {/if}

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(300px,1fr)]">
      <section class="rounded-2xl bg-ink p-5 text-white shadow-xs md:p-6">
        <p class="text-xs font-semibold text-white/55">全部資產</p>
        <p
          class="mt-3 text-4xl font-bold tracking-tight tabular-nums md:text-[40px]"
        >
          {formatCurrency(netWorth)}
        </p>
        <p class="mt-3 text-sm font-semibold text-emerald-300">
          淨資產 · 已扣除 {formatCurrency(cardDebt)} 信用卡負債
        </p>
        <div class="mt-5 flex h-3 overflow-hidden rounded-full bg-white/10">
          {#each allocation as item (item.label)}
            <span
              class={`h-full ${item.bar}`}
              style={`width:${pct(item.value)}%`}
            ></span>
          {/each}
        </div>
        <p class="mt-3 hidden text-xs text-white/65 md:block">
          {allocation
            .map((item) => `${item.label} ${pct(item.value)}%`)
            .join("　")}
        </p>
      </section>

      <Card class="hidden xl:block">
        <CardContent class="pt-6">
          <h2 class="text-lg font-semibold">同步健康度</h2>
          <p class="mt-3 text-3xl font-bold">
            {healthyCount} / {sourceCount} 來源正常
          </p>
          <Badge
            class="mt-3"
            variant={unhealthy.length ? "destructive" : "success"}
            >{unhealthy.length
              ? `${unhealthy.length} 個來源需要處理`
              : "所有來源同步正常"}</Badge
          >
          <p class="mt-2 text-xs text-ink/45">銀行與發票使用最近同步紀錄</p>
          <Button
            class="mt-4"
            variant="secondary"
            size="sm"
            onclick={() => navigate("settings")}>前往同步設定</Button
          >
        </CardContent>
      </Card>
    </div>

    <div class="grid grid-cols-3 gap-2 md:grid-cols-4 md:gap-4">
      {#each allocation as item (item.label)}
        <Card>
          <CardContent class="p-3 md:p-5">
            <p class="text-xs font-semibold text-ink/50 md:mt-0">
              {item.label === "其他" ? "其他資產" : item.label}
            </p>
            <p
              class={`mt-2 text-xl font-bold tabular-nums md:hidden ${item.text}`}
            >
              {formatCompactTwd(item.value)}
            </p>
            <p class="mt-1 text-[11px] text-ink/40 md:hidden">
              佔全部資產 {pct(item.value)}%
            </p>
            <p
              class={`mt-2 hidden text-2xl font-bold tabular-nums md:block ${item.text}`}
            >
              {formatCurrency(item.value)}
            </p>
            <p class="mt-1 hidden text-xs text-ink/40 md:block">
              {item.detail}
            </p>
          </CardContent>
        </Card>
      {/each}
      <Card class="hidden md:block">
        <CardContent class="p-5">
          <p class="text-xs font-semibold text-ink/50">本月淨流入</p>
          <p
            class={`mt-2 text-2xl font-bold tracking-tight tabular-nums ${monthlyIncome >= monthlyExpense ? "text-moss" : "text-coral"}`}
          >
            {formatCurrency(monthlyIncome - monthlyExpense)}
          </p>
          <p class="mt-1 text-xs text-ink/45">收入 − 支出</p>
        </CardContent>
      </Card>
    </div>

    <div class="xl:hidden">
      <NetWorthHistoryChart
        data={$history.data ?? []}
        loading={$history.isPending}
      />
    </div>

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(300px,1fr)]">
      <div class="hidden min-w-0 xl:block">
        <NetWorthHistoryChart
          data={$history.data ?? []}
          loading={$history.isPending}
        />
      </div>
      <Card>
        <CardHeader class="flex-row items-center justify-between">
          <h2 class="text-lg font-semibold">資產配置</h2>
          <Button variant="ghost" size="sm" onclick={() => navigate("assets")}
            >查看全部 →</Button
          >
        </CardHeader>
        <CardContent class="grid gap-5">
          {#each allocation as item (item.label)}
            <div>
              <div class="flex items-center justify-between gap-3">
                <div>
                  <span class="text-sm font-semibold">{item.label}</span><span
                    class="ml-2 text-xs text-ink/40">{item.detail}</span
                  >
                </div>
                <span class={`text-sm font-bold tabular-nums ${item.text}`}
                  >{formatCurrency(item.value)}</span
                >
              </div>
              <div class="mt-2 h-2 overflow-hidden rounded-full bg-ink/10">
                <span
                  class={`block h-full rounded-full ${item.bar}`}
                  style={`width:${pct(item.value)}%`}
                ></span>
              </div>
            </div>
          {/each}
        </CardContent>
      </Card>
    </div>

    {#if unhealthy.length > 0}
      <section class="rounded-2xl bg-amber-50 p-5 text-amber-900 md:hidden">
        <p class="font-semibold">{unhealthy.length} 個來源需要更新</p>
        <button
          class="mt-3 text-sm font-semibold"
          onclick={() => navigate("data-sources")}>立即處理 →</button
        >
      </section>
    {/if}

    <div
      class="hidden gap-5 xl:grid xl:grid-cols-[minmax(0,1.8fr)_minmax(300px,1fr)]"
    >
      <Card>
        <CardHeader class="flex-row items-center justify-between"
          ><h2 class="text-lg font-semibold">銀行與信用卡</h2>
          <Button variant="ghost" size="sm" onclick={() => navigate("assets")}
            >查看資產 →</Button
          ></CardHeader
        >
        <CardContent class="grid gap-4">
          {#each accountRows as account (account.id)}
            <div
              class="grid grid-cols-[120px_minmax(0,1fr)_auto_auto] gap-3 text-sm"
            >
              <span class="font-semibold"
                >{account.institutionName ?? account.connectorId}</span
              >
              <span class="truncate text-ink/45"
                >{account.accountName ?? formatBankAccountName(account)}</span
              >
              <span
                class={`font-semibold tabular-nums ${account.accountType === "credit" ? "text-coral" : ""}`}
                >{formatCurrency(account.balance ?? 0, account.currency)}</span
              >
              <span class="text-xs text-ink/40"
                >{account.asOfAt ? formatDate(account.asOfAt) : "—"}</span
              >
            </div>
          {/each}
        </CardContent>
      </Card>
      <Card class="min-w-0 overflow-hidden">
        <CardHeader><h2 class="text-lg font-semibold">近期活動</h2></CardHeader>
        <CardContent class="grid min-w-0 gap-4">
          {#each recent as item (item.id)}
            <div
              class="flex min-w-0 items-center justify-between gap-3 text-sm"
            >
              <div class="min-w-0 flex-1 overflow-hidden">
                <p class="truncate font-semibold">{item.title}</p>
                <p class="truncate text-xs text-ink/40">{item.detail}</p>
              </div>
              <span
                class={`max-w-[42%] shrink-0 truncate font-semibold tabular-nums ${item.amount != null && item.amount < 0 ? "text-coral" : item.amount != null ? "text-moss" : "text-ink/40"}`}
                >{item.amount == null
                  ? "—"
                  : `${item.amount >= 0 ? "+" : ""}${formatCurrency(item.amount, item.currency)}`}</span
              >
            </div>
          {/each}
        </CardContent>
      </Card>
    </div>
  </div>
{/if}
