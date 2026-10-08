<script lang="ts">
  import type { ApiClient } from "@/shared/api/client";
  import { toStore } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import SyncActivityDetails from "./SyncActivityDetails.svelte";
  import { CircleCheckBig, RefreshCw, TriangleAlert } from "@lucide/svelte";
  import {
    connectorCatalog,
    type ScheduledSyncReport,
  } from "@taiwan-fin-hub/shared";
  import { syncReportActivitiesQuery } from "@/data/sync-reports/queries";
  import { formatCurrency, formatDateTime } from "@/shared/format/financial";
  import {
    financialChangeUnavailableMessage,
    financialChangeScopeMessage,
    signedFinancialChange,
    syncReportStatusPresentation,
    syncReportRecoveryMessage,
  } from "../model/sync-report";

  let {
    report,
    api,
    loading = false,
  }: {
    report: ScheduledSyncReport | null | undefined;
    api: ApiClient;
    loading?: boolean;
  } = $props();

  const presentation = $derived(
    report ? syncReportStatusPresentation(report) : null,
  );
  const unavailableMessage = $derived(
    report
      ? financialChangeUnavailableMessage(
          report.financialChangeUnavailableReason,
        )
      : null,
  );
  const financialChangeScope = $derived(
    report ? financialChangeScopeMessage(report) : null,
  );
  const recoveryMessage = $derived(
    report ? syncReportRecoveryMessage(report) : null,
  );
  const newRecordItems = $derived(
    report
      ? [
          { label: "交易", value: report.newRecords.bankTransactions },
          { label: "發票", value: report.newRecords.invoices },
          {
            label: "投資交易",
            value: report.newRecords.investmentTransactions,
          },
        ]
      : [],
  );
  const financialItems = $derived(
    report?.financialChange
      ? [
          {
            label: "資產",
            value: report.financialChange.assets,
            positiveChangeIsFavorable: true,
          },
          {
            label: "信用卡負債",
            value: report.financialChange.creditCardDebt,
            positiveChangeIsFavorable: false,
          },
          {
            label: "淨資產",
            value: report.financialChange.netWorth,
            positiveChangeIsFavorable: true,
          },
        ]
      : [],
  );
  let sourcesOpen = $state(false);
  const activities = createQuery(
    toStore(() =>
      syncReportActivitiesQuery(
        () => api,
        report?.id ?? "",
        Boolean(report?.id) && sourcesOpen,
      ),
    ),
  );

  function formatFinancialChange(value: number) {
    const amount = formatCurrency(Math.abs(value));
    if (amount.includes("•")) return amount;
    return `${signedFinancialChange(value).sign}${amount}`;
  }

  function sourceStatusLabel(status: ScheduledSyncReport["status"]) {
    if (status === "success") return "完成";
    if (status === "needs_user_action") return "需要處理";
    return "失敗";
  }

  function sourceNewRecordSummary(
    source: ScheduledSyncReport["sources"][number],
  ) {
    const counts = [
      source.newRecords.bankTransactions > 0
        ? `交易 ${source.newRecords.bankTransactions}`
        : null,
      source.newRecords.invoices > 0
        ? `發票 ${source.newRecords.invoices}`
        : null,
      source.newRecords.investmentTransactions > 0
        ? `投資交易 ${source.newRecords.investmentTransactions}`
        : null,
    ].filter((item): item is string => item !== null);
    return counts.length > 0 ? `新增 ${counts.join("、")}` : "沒有新增資料";
  }
</script>

{#if loading}
  <div aria-busy="true">
    <div
      class="flex min-h-20 items-center gap-3 border-t border-ink/10 pt-5 text-subtle"
    >
      <RefreshCw class="size-5 animate-spin" />
      <p class="text-sm font-medium">讀取最近同步結果中</p>
    </div>
  </div>
{:else if report && presentation}
  <section
    aria-label="最近一次排程同步"
    class="min-w-0 border-t border-ink/10 pt-6"
  >
    <div class="grid gap-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 items-start gap-3">
          <span
            class={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full ${presentation.tone === "success" ? "bg-emerald-50 text-moss" : "bg-amber-50 text-amber-700"}`}
          >
            {#if presentation.tone === "success"}
              <CircleCheckBig class="size-5" />
            {:else}
              <TriangleAlert class="size-5" />
            {/if}
          </span>
          <div class="min-w-0">
            <p class="text-caption font-semibold text-subtle">
              最近一次排程同步
            </p>
            <h2 class="mt-1 text-base font-semibold">{presentation.label}</h2>
            <p class="mt-1 text-caption text-subtle">
              {presentation.description}
            </p>
            {#if recoveryMessage}
              <p class="mt-1 text-caption font-medium text-moss">
                已於 {formatDateTime(recoveryMessage)} 手動{report.status ===
                "success"
                  ? "補齊"
                  : "更新部分來源"}
              </p>
            {/if}
          </div>
        </div>
        <time
          class="text-caption font-medium text-subtle"
          datetime={report.completedAt}
          >{formatDateTime(report.completedAt)}</time
        >
      </div>

      <div class="grid gap-5 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div class="min-w-0 py-1">
          <p class="text-caption font-semibold text-subtle">新增資料</p>
          <div class="mt-3 grid grid-cols-3 gap-2">
            {#each newRecordItems as item (item.label)}
              <div class="min-w-0">
                <p class="text-lg font-medium tabular-nums">{item.value}</p>
                <p class="mt-1 truncate text-xs text-subtle">
                  {item.label}
                </p>
              </div>
            {/each}
          </div>
        </div>

        {#if report.financialChange}
          <div
            class="min-w-0 border-t border-ink/8 pt-4 md:border-t-0 md:border-l md:pl-6 md:pt-1"
          >
            <p class="text-caption font-semibold text-subtle">同步後變化</p>
            {#if financialChangeScope}
              <p class="mt-1 text-xs leading-relaxed text-amber-800">
                {financialChangeScope}
              </p>
            {/if}
            <div class="mt-3 grid gap-2 sm:grid-cols-3">
              {#each financialItems as item (item.label)}
                {@const change = signedFinancialChange(
                  item.value,
                  item.positiveChangeIsFavorable,
                )}
                <div
                  class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 sm:block"
                >
                  <p
                    class={`col-start-2 row-start-1 whitespace-nowrap text-right text-base font-medium tabular-nums sm:text-left sm:text-lg ${change.tone === "positive" ? "text-moss" : change.tone === "negative" ? "text-coral" : "text-ink"}`}
                  >
                    {formatFinancialChange(item.value)}
                  </p>
                  <p
                    class="col-start-1 row-start-1 truncate text-xs text-subtle sm:mt-1"
                  >
                    {item.label}
                  </p>
                </div>
              {/each}
            </div>
          </div>
        {:else if unavailableMessage}
          <div
            class="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-amber-900"
          >
            <TriangleAlert class="size-5 shrink-0" />
            <p class="text-caption font-medium leading-relaxed">
              {unavailableMessage}
            </p>
          </div>
        {/if}
      </div>

      {#if report.sources.length > 0}
        <details
          bind:open={sourcesOpen}
          class="group border-t border-border/70 pt-4"
        >
          <summary
            class="cursor-pointer list-none text-caption font-semibold text-steel marker:content-none"
          >
            <span class="group-open:hidden">查看各資料來源</span>
            <span class="hidden group-open:inline">收合各資料來源</span>
          </summary>
          <div class="mt-3 grid gap-2">
            {#each report.sources as source (`${report.id}:${source.connectorId}`)}
              <div class="border-b border-ink/8 py-3 last:border-b-0">
                <div
                  class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                >
                  <div class="min-w-0">
                    <p class="truncate text-caption font-semibold">
                      {connectorCatalog[source.connectorId].title}
                    </p>
                    <p class="mt-0.5 text-xs text-subtle">
                      {sourceNewRecordSummary(source)}
                    </p>
                  </div>
                  <span
                    class={`text-caption font-semibold ${source.status === "success" ? "text-moss" : "text-amber-700"}`}
                  >
                    {sourceStatusLabel(source.status)}
                  </span>
                </div>
                <SyncActivityDetails
                  page={$activities.data?.sources[source.connectorId]}
                  loading={$activities.isPending}
                  failed={$activities.isError}
                  onRetry={() => $activities.refetch()}
                />
              </div>
            {/each}
          </div>
        </details>
      {/if}
    </div>
  </section>
{/if}
