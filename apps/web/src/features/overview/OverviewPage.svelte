<script lang="ts">
  import {
    ChartNoAxesCombined,
    ChevronRight,
    CircleCheckBig,
    CreditCard,
    RefreshCw,
  } from "@lucide/svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import Button from "@/shared/ui/Button.svelte";
  import EmptyState from "@/shared/ui/EmptyState.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import {
    exchangeRatesQuery,
    manualAssetsQuery,
    netWorthHistoryQuery,
  } from "@/data/assets/queries";
  import { bankRangeQuery } from "@/data/bank/queries";
  import { syncJobsQuery } from "@/data/connectors/queries";
  import type { ConnectorId } from "@/data/connectors/types";
  import { latestSyncReportQuery } from "@/data/sync-reports/queries";
  import {
    getActionableSyncJobs,
    getConfiguredSyncJobs,
    getHealthySyncJobs,
    getPendingSyncJobs,
  } from "@/data/connectors/sync-status";
  import { investmentsQuery } from "@/data/investments/queries";
  import {
    invoiceTransactionMappingsQuery,
    invoicesRangeQuery,
  } from "@/data/invoices/queries";
  import { calculateMonthlyActivityTotals } from "@/data/activity/monthly-totals";
  import type { View } from "@/app/types";
  import {
    formatCompactTwd,
    formatCurrency,
    missingExchangeRateCurrencies,
    rateMap,
  } from "@/shared/format/financial";
  import NetWorthHistoryChart from "./components/NetWorthHistoryChart.svelte";
  import LatestSyncReportCard from "./components/LatestSyncReportCard.svelte";

  type InsightTone = "coral" | "amber" | "moss" | "steel";
  type InsightIcon = "sync" | "card" | "cashflow";

  interface OverviewInsight {
    id: string;
    title: string;
    detail: string;
    tone: InsightTone;
    icon: InsightIcon;
    view: View;
    connectorId?: ConnectorId;
  }

  let {
    api,
    navigate,
  }: {
    api: ApiClient;
    navigate: (view: View, connectorId?: ConnectorId) => void;
  } = $props();

  const monthKey = new Date().toISOString().slice(0, 7);
  const currentMonthRange = { from: monthKey, to: monthKey };
  const monthlyBank = createQuery(bankRangeQuery(() => api, currentMonthRange));
  const investments = createQuery(investmentsQuery(() => api));
  const monthlyInvoices = createQuery(
    invoicesRangeQuery(() => api, currentMonthRange),
  );
  const invoiceMappings = createQuery(
    invoiceTransactionMappingsQuery(() => api),
  );
  const manualAssets = createQuery(manualAssetsQuery(() => api));
  const rates = createQuery(exchangeRatesQuery(() => api));
  const jobs = createQuery(syncJobsQuery(() => api));
  const latestSyncReport = createQuery(latestSyncReportQuery(() => api));
  const history = createQuery(netWorthHistoryQuery(() => api));

  const bankData = $derived(
    $monthlyBank.data ?? { accounts: [], transactions: [] },
  );
  const rateValues = $derived(rateMap($rates.data));
  const toTwd = (value: number, currency: string) =>
    currency === "TWD" ? value : value * (rateValues[currency] ?? 0);
  const deposits = $derived(
    bankData.accounts.filter(
      (account) =>
        account.accountType !== "credit" && account.accountType !== "loan",
    ),
  );
  const cards = $derived(
    bankData.accounts.filter((account) => account.accountType === "credit"),
  );
  const loans = $derived(
    bankData.accounts.filter((account) => account.accountType === "loan"),
  );
  const depositTotal = $derived(
    deposits.reduce(
      (sum, account) => sum + toTwd(account.balance ?? 0, account.currency),
      0,
    ),
  );
  const cardDebt = $derived(
    cards.reduce(
      (sum, account) => sum - toTwd(account.balance ?? 0, account.currency),
      0,
    ),
  );
  const loanDebt = $derived(
    loans.reduce(
      (sum, account) => sum - toTwd(account.balance ?? 0, account.currency),
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
      (sum, item) => sum + toTwd(item.value ?? 0, item.currency),
      0,
    ),
  );
  const gross = $derived(depositTotal + investmentTotal + manualTotal);
  const netWorth = $derived(gross - cardDebt - loanDebt);
  const allocation = $derived([
    {
      label: "銀行與現金",
      value: depositTotal,
      detail: `${deposits.length} 個帳戶`,
    },
    {
      label: "投資",
      value: investmentTotal,
      detail: `${$investments.data?.length ?? 0} 個持倉`,
    },
    {
      label: "其他資產",
      value: manualTotal,
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
  const monthlyNet = $derived(monthlyIncome - monthlyExpense);
  const syncJobsReady = $derived($jobs.isSuccess);
  const syncJobRows = $derived($jobs.data ?? []);
  const unhealthy = $derived(getActionableSyncJobs(syncJobRows));
  const pendingSyncJobs = $derived(getPendingSyncJobs(syncJobRows));
  const configuredSyncJobs = $derived(getConfiguredSyncJobs(syncJobRows));
  const healthySyncJobs = $derived(getHealthySyncJobs(syncJobRows));
  const staleJobs = $derived(
    syncJobsReady
      ? configuredSyncJobs.filter(
          (job) =>
            job.enabled &&
            !job.running &&
            !unhealthy.some((unhealthyJob) => unhealthyJob.id === job.id) &&
            Boolean(job.lastSuccessAt) &&
            Date.now() - new Date(job.lastSuccessAt!).getTime() >
              48 * 60 * 60 * 1000,
        )
      : [],
  );
  const sourceCount = $derived(configuredSyncJobs.length);
  const healthyCount = $derived(healthySyncJobs.length);
  const insights = $derived.by(() => {
    const items: OverviewInsight[] = [];

    if (!syncJobsReady) {
      items.push({
        id: "sync-status-unavailable",
        title: $jobs.isError ? "無法載入同步狀態" : "正在載入同步狀態",
        detail: $jobs.isError
          ? "目前無法確認資料來源狀態，請稍後再試"
          : "正在讀取資料來源狀態",
        tone: $jobs.isError ? "coral" : "steel",
        icon: "sync",
        view: "data-sources",
      });
    } else if (sourceCount === 0) {
      items.push({
        id: "sync-unconfigured",
        title: "尚未設定資料來源",
        detail: "前往資料來源設定連接器後即可開始同步",
        tone: "steel",
        icon: "sync",
        view: "data-sources",
      });
    } else if (unhealthy.length > 0) {
      items.push({
        id: "sync",
        title: `${unhealthy.length} 個資料來源需要處理`,
        detail: pendingSyncJobs.length
          ? `目前 ${healthyCount} 個來源正常，${pendingSyncJobs.length} 個等待首次同步`
          : `目前 ${healthyCount} / ${sourceCount} 個來源正常`,
        tone: "amber",
        icon: "sync",
        view: "data-sources",
        connectorId: unhealthy[0]?.connectorId,
      });
    } else if (pendingSyncJobs.length > 0) {
      items.push({
        id: "sync-pending",
        title: `${pendingSyncJobs.length} 個資料來源等待首次同步`,
        detail: `目前 ${healthyCount} / ${sourceCount} 個來源正常`,
        tone: "amber",
        icon: "sync",
        view: "data-sources",
        connectorId: pendingSyncJobs[0]?.connectorId,
      });
    }

    if (staleJobs.length > 0) {
      items.push({
        id: "stale-sync",
        title: `${staleJobs.length} 個資料來源超過 48 小時未更新`,
        detail: "重新同步以取得最新的資產與活動資料",
        tone: "steel",
        icon: "sync",
        view: "data-sources",
        connectorId: staleJobs[0]?.connectorId,
      });
    }

    if (monthlyNet < 0) {
      items.push({
        id: "negative-cashflow",
        title: `本月支出高於收入 ${formatCurrency(Math.abs(monthlyNet))}`,
        detail: "查看活動分類，確認主要支出來源",
        tone: "coral",
        icon: "cashflow",
        view: "activity",
      });
    }

    const highCardDebt =
      cardDebt > 0 &&
      (monthlyIncome > 0
        ? cardDebt > monthlyIncome * 0.5
        : depositTotal > 0 && cardDebt > depositTotal * 0.2);

    if (highCardDebt) {
      items.push({
        id: "high-card-debt",
        title: `信用卡負債已達 ${formatCurrency(cardDebt)}`,
        detail:
          monthlyIncome > 0
            ? `約為本月收入的 ${Math.round((cardDebt / monthlyIncome) * 100)}%`
            : "信用卡負債相對可動用存款偏高",
        tone: "coral",
        icon: "card",
        view: "assets",
      });
    }

    return items.slice(0, 2);
  });
  const missingRates = $derived(
    $rates.isSuccess
      ? missingExchangeRateCurrencies(
          [
            ...deposits.map((account) => ({
              currency: account.currency,
              amount: account.balance ?? 0,
            })),
            ...cards.map((account) => ({
              currency: account.currency,
              amount: Math.abs(account.balance ?? 0),
            })),
            ...loans.map((account) => ({
              currency: account.currency,
              amount: Math.abs(account.balance ?? 0),
            })),
            ...($investments.data ?? []).map((item) => ({
              currency: item.currency,
              amount: (item.marketValue ?? 0) + (item.cashBalance ?? 0),
            })),
            ...($manualAssets.data ?? []).map((item) => ({
              currency: item.currency,
              amount: item.value ?? 0,
            })),
          ],
          rateValues,
        )
      : [],
  );
  const loading = $derived(
    $monthlyBank.isPending ||
      $monthlyInvoices.isPending ||
      $invoiceMappings.isPending ||
      $investments.isPending ||
      $manualAssets.isPending,
  );
  const failed = $derived(
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
    alert
    title="無法載入總覽"
    body="請稍後再試，或確認 Worker API 是否可用。"
  />
{:else}
  <div class="grid min-w-0 gap-6 md:gap-8">
    {#if missingRates.length}
      <div
        class="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
      >
        <span
          >資產含外幣（{missingRates.join("、")}）尚未設定匯率，TWD
          總額可能不準確。</span
        >
        <button
          class="shrink-0 font-semibold underline underline-offset-2"
          onclick={() => navigate("settings")}>前往設定</button
        >
      </div>
    {/if}

    <section class="min-w-0 pt-3 md:pt-2" aria-label="淨資產">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-subtle">淨資產</p>
        <p class="text-caption text-subtle">
          {new Intl.DateTimeFormat("zh-TW", {
            year: "numeric",
            month: "long",
            day: "numeric",
          }).format(new Date())}
        </p>
      </div>
      <p
        class="mt-3 break-all text-[clamp(2rem,7vw,2.75rem)] leading-tight font-semibold tracking-tight tabular-nums"
      >
        {formatCurrency(netWorth)}
      </p>
      <div class="mt-3 grid gap-1 text-caption text-subtle">
        <p>
          {#if cardDebt < 0}
            已計入 {formatCurrency(-cardDebt)} 信用卡溢繳餘額
          {:else}
            已扣除 {formatCurrency(cardDebt)} 信用卡負債
          {/if}
        </p>
        <p>已扣除 {formatCurrency(loanDebt)} 貸款負債</p>
      </div>
      <div class="mt-6 grid grid-cols-3 gap-3 md:gap-6">
        {#each allocation as item (item.label)}
          <div class="min-w-0">
            <p class="text-caption text-subtle">
              {item.label}
            </p>
            <p
              class="mt-2 text-lg font-medium tracking-tight tabular-nums md:hidden"
            >
              {formatCompactTwd(item.value)}
            </p>
            <p
              class="mt-2 hidden break-all text-2xl font-semibold tracking-tight tabular-nums md:block"
            >
              {formatCurrency(item.value)}
            </p>
            <p class="mt-1 text-caption text-subtle">
              {item.detail}
            </p>
          </div>
        {/each}
      </div>
    </section>

    <div class="min-w-0 border-t border-ink/10 pt-6">
      <NetWorthHistoryChart
        data={$history.data ?? []}
        loading={$history.isPending}
      />
    </div>

    <section class="min-w-0 border-t border-ink/10 pt-5" aria-label="本月收支">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h2 class="text-base font-semibold">本月收支</h2>
          <p class="mt-1 text-caption leading-6 text-ink/70">
            銀行與信用卡活動，含未配對發票
          </p>
        </div>
        <Button variant="ghost" size="sm" onclick={() => navigate("activity")}
          >查看活動 →</Button
        >
      </div>
      <div class="mt-5 grid grid-cols-2 gap-5 md:grid-cols-3 md:gap-6">
        <div class="min-w-0">
          <p class="text-sm font-medium text-ink">收入</p>
          <p
            class="mt-2 whitespace-nowrap text-lg font-semibold tracking-tight text-moss tabular-nums md:text-2xl"
          >
            +{formatCurrency(monthlyIncome)}
          </p>
        </div>
        <div class="min-w-0">
          <p class="text-sm font-medium text-ink">支出</p>
          <p
            class="mt-2 whitespace-nowrap text-lg font-semibold tracking-tight text-coral tabular-nums md:text-2xl"
          >
            −{formatCurrency(monthlyExpense)}
          </p>
        </div>
        <div class="col-span-2 min-w-0 md:col-span-1">
          <p class="text-sm font-medium text-ink">淨流入</p>
          <p
            class={`mt-2 whitespace-nowrap text-lg font-semibold tracking-tight tabular-nums md:text-2xl ${monthlyNet >= 0 ? "text-moss" : "text-coral"}`}
          >
            {formatCurrency(monthlyNet)}
          </p>
        </div>
      </div>
    </section>

    <section
      class="min-w-0 border-t border-ink/10 pt-5"
      aria-labelledby="overview-insights"
    >
      <div class="flex flex-col gap-2 md:flex-row md:items-center md:gap-6">
        <h2
          id="overview-insights"
          class="shrink-0 text-caption font-medium text-subtle"
        >
          值得留意
        </h2>
        {#if insights.length === 0}
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
            <CircleCheckBig class="size-4 shrink-0 text-moss" />
            <p>目前沒有需要處理的事項</p>
            <p class="text-subtle">同步與本月收支狀態正常</p>
          </div>
        {:else}
          <div class="grid min-w-0 flex-1 gap-x-8 gap-y-2 lg:grid-cols-2">
            {#each insights as insight (insight.id)}
              <button
                class="group flex min-h-11 min-w-0 items-center gap-3 rounded-sm py-1 text-left transition hover:bg-ink/3"
                onclick={() => navigate(insight.view, insight.connectorId)}
              >
                {#if insight.icon === "sync"}
                  <RefreshCw
                    class={`size-4 shrink-0 ${insight.tone === "amber" ? "text-amber-600" : "text-steel"}`}
                  />
                {:else if insight.icon === "card"}
                  <CreditCard class="size-4 shrink-0 text-coral" />
                {:else}
                  <ChartNoAxesCombined
                    class={`size-4 shrink-0 ${insight.tone === "moss" ? "text-moss" : "text-coral"}`}
                  />
                {/if}
                <span class="min-w-0 flex-1"
                  ><span class="block text-caption font-medium"
                    >{insight.title}</span
                  ><span class="mt-1 block text-xs text-subtle"
                    >{insight.detail}</span
                  ></span
                >
                <ChevronRight
                  class="size-3.5 shrink-0 text-subtle transition group-hover:translate-x-0.5"
                />
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </section>

    <LatestSyncReportCard
      {api}
      report={$latestSyncReport.data}
      loading={$latestSyncReport.isPending}
    />
  </div>
{/if}
