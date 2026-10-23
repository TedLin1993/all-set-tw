<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Search } from "@lucide/svelte";
  import EmptyState from "@/shared/ui/EmptyState.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { exchangeRatesQuery } from "@/data/assets/queries";
  import {
    investmentsQuery,
    investmentTransactionsQuery,
  } from "@/data/investments/queries";
  import type { InvestmentTransactionRow } from "@/data/investments/types";
  import {
    formatCurrency,
    formatDate,
    formatNumber,
    rateMap,
  } from "@/shared/format/financial";
  let { api }: { api: ApiClient } = $props();
  const investments = createQuery(() => investmentsQuery(() => api));
  const trades = createQuery(() => investmentTransactionsQuery(() => api));
  const rates = createQuery(() => exchangeRatesQuery(() => api));
  let search = $state("");
  let tradeType = $state("all");
  const positions = $derived(
    (investments.data ?? []).filter((p) =>
      `${p.symbol ?? ""} ${p.name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
  );
  const rateValues = $derived(rateMap(rates.data));
  const total = $derived(
    (investments.data ?? []).reduce((s, p) => {
      const value = (p.marketValue ?? 0) + (p.cashBalance ?? 0);
      return (
        s +
        (p.currency === "TWD" ? value : value * (rateValues[p.currency] ?? 0))
      );
    }, 0),
  );
  const filteredTrades = $derived(
    (trades.data ?? [])
      .filter(
        (t) =>
          (tradeType === "all" || t.assetType === tradeType) &&
          `${t.symbol ?? ""} ${t.name ?? ""} ${t.transactionName ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      )
      .slice(0, 100),
  );
  function tradeDisplay(t: InvestmentTransactionRow) {
    if (t.amount != null && t.price != null && t.price !== 1)
      return formatCurrency(t.amount, t.currency);
    if (t.quantity != null) return `${formatNumber(t.quantity)} 股`;
    return "金額未提供";
  }
</script>

{#if investments.isPending}
  <EmptyState title="載入投資中" body="正在讀取投資持倉。" />
{:else if investments.isError || rates.isError}
  <EmptyState
    alert
    title="無法載入投資"
    body="必要的投資或匯率資料目前無法取得，請稍後再試。"
  />
{:else}
  <div class="grid min-w-0 gap-6">
    <section class="min-w-0 pt-3 md:pt-2" aria-label="投資摘要">
      <p class="text-sm text-subtle">持倉市值</p>
      <p
        class="mt-3 break-all text-[clamp(2rem,7vw,2.75rem)] leading-tight font-semibold tracking-tight tabular-nums"
      >
        {formatCurrency(total)}
      </p>
      <div class="mt-5 grid grid-cols-2 gap-3 md:gap-6">
        <div class="min-w-0">
          <p class="text-caption text-subtle">持倉數</p>
          <p class="mt-2 text-lg font-medium tracking-tight tabular-nums">
            {positions.length}
          </p>
        </div>
        <div class="min-w-0">
          <p class="text-caption text-subtle">交易筆數</p>
          <p class="mt-2 text-lg font-medium tracking-tight tabular-nums">
            {trades.isError ? "—" : (trades.data?.length ?? 0)}
          </p>
        </div>
      </div>
    </section>

    <section class="min-w-0 border-t border-ink/10 pt-5" aria-label="投資持倉">
      <div class="flex flex-wrap items-center justify-between gap-3 pb-4">
        <h2 class="text-base font-semibold">投資持倉</h2>
        <div class="relative w-52">
          <Search
            class="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-subtle"
          />
          <Input
            class="pl-9"
            placeholder="搜尋股票／基金"
            bind:value={search}
          />
        </div>
      </div>
      {#if positions.length === 0}
        <p class="py-8 text-center text-sm text-subtle">
          {search.trim() ? "沒有符合的持倉。" : "尚無投資持倉。"}
        </p>
      {:else}
        <div class="hidden overflow-x-auto md:block">
          <table class="w-full text-left text-sm">
            <thead class="border-y border-ink/8 text-caption text-subtle">
              <tr>
                <th class="py-3 pr-4">名稱</th>
                <th class="px-4 py-3">類型</th>
                <th class="px-4 py-3">數量</th>
                <th class="px-4 py-3 text-right">市值</th>
                <th class="py-3 pl-4">日期</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-ink/8">
              {#each positions as p (p.id)}
                <tr>
                  <td class="py-3 pr-4 font-semibold">
                    {p.symbol ? `${p.symbol} ` : ""}{p.name}
                  </td>
                  <td class="px-4 py-3">{p.assetType.toUpperCase()}</td>
                  <td class="px-4 py-3">
                    {p.quantity == null ? "-" : formatNumber(p.quantity)}
                  </td>
                  <td class="px-4 py-3 text-right font-semibold tabular-nums">
                    {formatCurrency(
                      (p.marketValue ?? 0) + (p.cashBalance ?? 0),
                      p.currency,
                    )}
                  </td>
                  <td class="py-3 pl-4 text-caption text-subtle">
                    {formatDate(p.asOfDate)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="divide-y divide-ink/8 md:hidden">
          {#each positions as p (p.id)}
            <div class="flex items-center justify-between gap-3 py-3">
              <div class="min-w-0">
                <p class="truncate font-semibold">
                  {p.symbol ? `${p.symbol} ` : ""}{p.name}
                </p>
                <p class="mt-1 text-caption text-subtle">
                  {p.quantity ?? 0} 單位 · {p.assetType.toUpperCase()}
                </p>
              </div>
              <p class="shrink-0 font-medium tabular-nums text-steel">
                {formatCurrency(
                  (p.marketValue ?? 0) + (p.cashBalance ?? 0),
                  p.currency,
                )}
              </p>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="min-w-0 border-t border-ink/10 pt-5" aria-label="交易紀錄">
      <div class="flex flex-wrap items-center justify-between gap-3 pb-4">
        <h2 class="text-base font-semibold">交易紀錄</h2>
        <Select class="w-36" bind:value={tradeType}>
          <option value="all">全部類型</option>
          <option value="stock">股票</option>
          <option value="etf">ETF</option>
          <option value="fund">基金</option>
        </Select>
      </div>
      {#if trades.isPending}
        <p class="py-8 text-center text-sm text-subtle">正在載入交易紀錄。</p>
      {:else if trades.isError}
        <p class="py-8 text-center text-sm text-coral">
          交易紀錄暫時無法載入。
        </p>
      {:else if filteredTrades.length === 0}
        <p class="py-8 text-center text-sm text-subtle">尚無交易紀錄。</p>
      {:else}
        <div class="divide-y divide-ink/8">
          {#each filteredTrades as t (t.id)}
            <div class="flex items-center justify-between gap-3 py-3 text-sm">
              <div class="min-w-0">
                <p class="truncate font-semibold">
                  {t.name ?? t.symbol ?? "投資交易"}
                </p>
                <p class="mt-1 text-caption text-subtle">
                  {t.transactionName ?? t.transactionCode ?? ""} · {formatDate(
                    t.tradeDate ?? t.postedDate,
                  )}
                </p>
              </div>
              <span class="shrink-0 font-medium tabular-nums">
                {tradeDisplay(t)}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>
{/if}
