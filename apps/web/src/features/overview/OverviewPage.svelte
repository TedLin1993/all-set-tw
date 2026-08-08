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
  import Card from "@/shared/ui/Card.svelte";
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
    getActionableSyncJobs,
    getConfiguredSyncJobs,
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
    rateMap,
  } from "@/shared/format/financial";
  import NetWorthHistoryChart from "./components/NetWorthHistoryChart.svelte";

  type InsightTone = "coral" | "amber" | "moss" | "steel";
  type InsightIcon = "sync" | "card" | "cashflow";

  interface OverviewInsight {
    id: string;
    title: string;
    detail: string;
    tone: InsightTone;
    icon: InsightIcon;
    view: View;
  }

  let { api, navigate }: { api: ApiClient; navigate: (view: View) => void } =
    $props();

  const bank = createQuery(bankQuery(() => api));
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
      (sum, item) => sum + toTwd(item.value ?? 0, item.currency),
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
  const monthlyNet = $derived(monthlyIncome - monthlyExpense);
  const unhealthy = $derived(getActionableSyncJobs($jobs.data ?? []));
  const configuredSyncJobs = $derived(getConfiguredSyncJobs($jobs.data ?? []));
  const staleJobs = $derived(
    configuredSyncJobs.filter(
      (job) =>
        job.enabled &&
        !job.running &&
        !unhealthy.some((unhealthyJob) => unhealthyJob.id === job.id) &&
        (!job.lastSuccessAt ||
          Date.now() - new Date(job.lastSuccessAt).getTime() >
            48 * 60 * 60 * 1000),
    ),
  );
  const sourceCount = $derived(configuredSyncJobs.length);
  const healthyCount = $derived(Math.max(sourceCount - unhealthy.length, 0));
  const insights = $derived.by(() => {
    const items: OverviewInsight[] = [];

    if (unhealthy.length > 0) {
      items.push({
        id: "sync",
        title: `${unhealthy.length} 個資料來源需要處理`,
        detail: `目前 ${healthyCount} / ${sourceCount} 個來源正常`,
        tone: "amber",
        icon: "sync",
        view: "data-sources",
      });
    }

    if (staleJobs.length > 0) {
      items.push({
        id: "stale-sync",
        title: `${staleJobs.length} 個資料來源超過 48 小時未更新`,
        detail: "重新同步以取得最新的資產與活動資料",
        tone: "amber",
        icon: "sync",
        view: "data-sources",
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
  const missingRates = $derived([
    ...new Set(
      [
        ...bankData.accounts.map((account) => account.currency),
        ...($investments.data ?? []).map((item) => item.currency),
        ...($manualAssets.data ?? []).map((item) => item.currency),
      ].filter((currency) => currency !== "TWD" && !rateValues[currency]),
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
          >資產含外幣（{missingRates.join("、")}）尚未設定匯率，TWD
          總額可能不準確。</span
        >
        <button
          class="shrink-0 font-semibold underline underline-offset-2"
          onclick={() => navigate("settings")}>前往設定</button
        >
      </div>
    {/if}

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_340px]">
      <section class="rounded-xl bg-ink p-5 text-white shadow-xs md:p-6">
        <div class="flex items-center justify-between gap-3">
          <p class="text-xs font-semibold text-white/55">淨資產</p>
          <p class="hidden text-xs text-white/40 sm:block">
            {new Intl.DateTimeFormat("zh-TW", {
              year: "numeric",
              month: "long",
              day: "numeric",
            }).format(new Date())}
          </p>
        </div>
        <p
          class="mt-3 text-4xl font-bold tracking-tight tabular-nums md:text-[40px]"
        >
          {formatCurrency(netWorth)}
        </p>
        <p class="mt-3 text-sm font-semibold text-emerald-300">
          已扣除 {formatCurrency(cardDebt)} 信用卡負債
        </p>
        <div class="mt-5 flex h-2.5 overflow-hidden rounded-full bg-white/10">
          {#each allocation as item (item.label)}
            <span
              class={`h-full ${item.bar}`}
              style={`width:${pct(item.value)}%`}
            ></span>
          {/each}
        </div>
      </section>

      <section
        class="hidden xl:block"
        aria-labelledby="overview-desktop-cashflow"
      >
        <Card class="h-full">
          <CardContent class="grid h-full gap-3 p-5">
            <div class="flex items-center justify-between gap-3">
              <h2
                id="overview-desktop-cashflow"
                class="text-base font-semibold"
              >
                本月財務脈動
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => navigate("activity")}>查看活動 →</Button
              >
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="min-w-0 rounded-xl bg-moss/10 p-3">
                <p class="text-[11px] font-semibold text-ink/50">收入</p>
                <p
                  class="mt-1.5 truncate text-base font-bold text-moss tabular-nums"
                >
                  +{formatCurrency(monthlyIncome)}
                </p>
              </div>
              <div class="min-w-0 rounded-xl bg-coral/10 p-3">
                <p class="text-[11px] font-semibold text-ink/50">支出</p>
                <p
                  class="mt-1.5 truncate text-base font-bold text-coral tabular-nums"
                >
                  −{formatCurrency(monthlyExpense)}
                </p>
              </div>
            </div>
            <div class="flex items-end justify-between gap-3 px-0.5">
              <div>
                <p class="text-xs font-semibold text-ink/50">本月淨流入</p>
                <p class="mt-1 text-xs text-ink/40">收入 − 支出</p>
              </div>
              <p
                class={`text-xl font-bold tabular-nums ${monthlyNet >= 0 ? "text-moss" : "text-coral"}`}
              >
                {formatCurrency(monthlyNet)}
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>

    <Card class="overflow-hidden">
      <CardContent class="grid grid-cols-3 divide-x divide-border p-0">
        {#each allocation as item (item.label)}
          <div
            class="flex min-w-0 flex-col justify-center px-3 py-4 md:min-h-28 md:px-5 md:py-5"
          >
            <div class="flex min-w-0 items-center gap-2">
              <span class={`size-2 shrink-0 rounded-full ${item.bar}`}></span>
              <p class="truncate text-xs font-semibold text-ink/50">
                {item.label === "其他" ? "其他資產" : item.label}
              </p>
            </div>
            <p
              class={`mt-2 truncate text-lg font-bold tracking-tight tabular-nums sm:text-xl md:hidden ${item.text}`}
            >
              {formatCompactTwd(item.value)}
            </p>
            <p
              class="mt-2 hidden truncate text-2xl font-bold tracking-tight tabular-nums md:block"
            >
              {formatCurrency(item.value)}
            </p>
            <p class="mt-1 truncate text-[11px] text-ink/40 md:text-xs">
              {item.detail}
            </p>
          </div>
        {/each}
      </CardContent>
    </Card>

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_340px]">
      <div class="min-w-0">
        <NetWorthHistoryChart
          data={$history.data ?? []}
          loading={$history.isPending}
        />
      </div>

      <section
        class="hidden xl:block"
        aria-labelledby="overview-desktop-insights"
      >
        <Card class="h-full">
          <CardContent class="grid gap-3 p-5">
            <h2 id="overview-desktop-insights" class="text-base font-semibold">
              值得留意
            </h2>
            {#if insights.length === 0}
              <div
                class="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4"
              >
                <CircleCheckBig class="size-5 shrink-0 text-moss" />
                <div class="min-w-0">
                  <p class="text-xs font-semibold">目前沒有需要處理的事項</p>
                  <p class="mt-1 text-[11px] text-ink/45">
                    同步與本月收支狀態正常
                  </p>
                </div>
              </div>
            {:else}
              {#each insights as insight (insight.id)}
                <button
                  class={`flex min-w-0 items-center gap-3 rounded-lg border p-3 text-left transition hover:brightness-[0.98] ${
                    insight.tone === "coral"
                      ? "border-red-200 bg-red-50/70"
                      : insight.tone === "amber"
                        ? "border-amber-200 bg-amber-50/70"
                        : insight.tone === "moss"
                          ? "border-emerald-200 bg-emerald-50/70"
                          : "border-sky-200 bg-sky-50/70"
                  }`}
                  onclick={() => navigate(insight.view)}
                >
                  {#if insight.icon === "sync"}
                    <RefreshCw class="size-5 shrink-0 text-amber-600" />
                  {:else if insight.icon === "card"}
                    <CreditCard class="size-5 shrink-0 text-coral" />
                  {:else}
                    <ChartNoAxesCombined
                      class={`size-5 shrink-0 ${insight.tone === "moss" ? "text-moss" : "text-coral"}`}
                    />
                  {/if}
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-xs font-semibold"
                      >{insight.title}</span
                    >
                    <span class="mt-1 block truncate text-[11px] text-ink/45"
                      >{insight.detail}</span
                    >
                  </span>
                  <ChevronRight class="size-4 shrink-0 text-ink/40" />
                </button>
              {/each}
            {/if}
          </CardContent>
        </Card>
      </section>
    </div>

    <section
      class="grid gap-3 xl:hidden"
      aria-labelledby="overview-mobile-cashflow"
    >
      <div class="flex items-center justify-between gap-3 px-1">
        <h2 id="overview-mobile-cashflow" class="text-lg font-semibold">
          本月收支
        </h2>
        <Button variant="ghost" size="sm" onclick={() => navigate("activity")}
          >查看活動 →</Button
        >
      </div>
      <div class="grid grid-cols-2 gap-3">
        <Card>
          <CardContent class="p-4">
            <p class="text-xs font-semibold text-ink/50">
              {Number(monthKey.slice(5))} 月收入
            </p>
            <p
              class="mt-2 truncate text-lg font-bold text-moss tabular-nums sm:text-xl"
            >
              +{formatCurrency(monthlyIncome)}
            </p>
            <p class="mt-1 text-[11px] text-ink/45">銀行與信用卡活動</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent class="p-4">
            <p class="text-xs font-semibold text-ink/50">
              {Number(monthKey.slice(5))} 月支出
            </p>
            <p
              class="mt-2 truncate text-lg font-bold text-coral tabular-nums sm:text-xl"
            >
              −{formatCurrency(monthlyExpense)}
            </p>
            <p class="mt-1 text-[11px] text-ink/45">含未配對發票</p>
          </CardContent>
        </Card>
        <Card class="col-span-2">
          <CardContent
            class="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 p-4 sm:min-h-24 sm:p-5"
          >
            <div>
              <p class="text-xs font-semibold text-ink/50">
                {Number(monthKey.slice(5))} 月淨流入
              </p>
              <p class="mt-1 text-[11px] text-ink/45">收入 − 支出</p>
            </div>
            <p
              class={`text-2xl font-bold tracking-tight tabular-nums sm:text-3xl ${monthlyNet >= 0 ? "text-moss" : "text-coral"}`}
            >
              {formatCurrency(monthlyNet)}
            </p>
          </CardContent>
        </Card>
      </div>
    </section>

    <section class="xl:hidden" aria-labelledby="overview-mobile-insights">
      <Card>
        <CardContent class="grid gap-3 p-4">
          <div class="flex items-center justify-between gap-3">
            <h2 id="overview-mobile-insights" class="text-base font-semibold">
              值得留意
            </h2>
            <span
              class="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-ink/50"
              >{insights.length}</span
            >
          </div>
          {#if insights.length === 0}
            <div
              class="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3"
            >
              <CircleCheckBig class="size-5 shrink-0 text-moss" />
              <div class="min-w-0">
                <p class="text-xs font-semibold">目前沒有需要處理的事項</p>
                <p class="mt-1 text-[11px] text-ink/45">
                  同步與本月收支狀態正常
                </p>
              </div>
            </div>
          {:else}
            {#each insights as insight (insight.id)}
              <button
                class={`flex min-w-0 items-center gap-3 rounded-lg border p-3 text-left ${
                  insight.tone === "coral"
                    ? "border-red-200 bg-red-50/70"
                    : insight.tone === "amber"
                      ? "border-amber-200 bg-amber-50/70"
                      : insight.tone === "moss"
                        ? "border-emerald-200 bg-emerald-50/70"
                        : "border-sky-200 bg-sky-50/70"
                }`}
                onclick={() => navigate(insight.view)}
              >
                {#if insight.icon === "sync"}
                  <RefreshCw class="size-5 shrink-0 text-amber-600" />
                {:else if insight.icon === "card"}
                  <CreditCard class="size-5 shrink-0 text-coral" />
                {:else}
                  <ChartNoAxesCombined
                    class={`size-5 shrink-0 ${insight.tone === "moss" ? "text-moss" : "text-coral"}`}
                  />
                {/if}
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-semibold"
                    >{insight.title}</span
                  >
                  <span class="mt-1 block truncate text-[11px] text-ink/45"
                    >{insight.detail}</span
                  >
                </span>
                <ChevronRight class="size-4 shrink-0 text-ink/40" />
              </button>
            {/each}
          {/if}
        </CardContent>
      </Card>
    </section>
  </div>
{/if}
