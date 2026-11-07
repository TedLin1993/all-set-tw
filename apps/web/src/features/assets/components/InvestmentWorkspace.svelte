<script lang="ts">
  import type {
    InvestmentRow,
    InvestmentTransactionRow,
  } from "@/data/investments/types";
  import { formatCurrency } from "@/shared/format/financial";
  import {
    tradeAmountText,
    tradeRealizedPnl,
    tradeSummary,
  } from "../model/investment-display";
  import InvestmentHoldings from "./InvestmentHoldings.svelte";
  import { listedHoldingCount } from "@/data/investments/holding-groups";

  let {
    positions,
    rates,
    trades,
    total,
    tradesPending = false,
    tradesError = false,
    compact = false,
  }: {
    positions: InvestmentRow[];
    rates: Readonly<Record<string, number>>;
    trades: InvestmentTransactionRow[];
    total: number;
    tradesPending?: boolean;
    tradesError?: boolean;
    compact?: boolean;
  } = $props();

  let tab = $state<"holdings" | "transactions">("holdings");

  const pnlClass = {
    gain: "text-moss",
    loss: "text-coral",
    unknown: "text-subtle",
  };
</script>

<div class={compact ? "grid gap-3" : "flex min-h-full flex-col"}>
  {#if !compact}
    <header class="border-b border-ink/10 px-5 py-4">
      <p class="text-caption font-medium text-subtle">投資</p>
      <h2 class="mt-1 text-xl font-semibold tracking-tight">投資組合</h2>
      <p class="mt-1 text-caption text-subtle">持倉與交易紀錄集中查看</p>
    </header>
    <div class="grid grid-cols-2 gap-6 border-b border-ink/10 px-5 py-4">
      <div>
        <p class="text-caption text-subtle">投資市值</p>
        <p class="mt-2 text-lg font-medium tabular-nums text-steel">
          {formatCurrency(total)}
        </p>
      </div>
      <div>
        <p class="text-caption text-subtle">持倉</p>
        <p class="mt-2 text-lg font-medium tabular-nums">
          {listedHoldingCount(positions, rates)} 筆
        </p>
      </div>
    </div>
  {/if}

  <div
    class={`flex gap-1 border-b border-ink/8 pt-2 ${compact ? "" : "px-4"}`}
    role="tablist"
    aria-label="投資組合"
  >
    <button
      class={`min-h-10 border-b-2 px-3 text-sm font-semibold ${tab === "holdings" ? "border-steel text-ink" : "border-transparent text-subtle"}`}
      type="button"
      role="tab"
      aria-selected={tab === "holdings"}
      onclick={() => (tab = "holdings")}>持倉</button
    >
    <button
      class={`min-h-10 border-b-2 px-3 text-sm font-semibold ${tab === "transactions" ? "border-steel text-ink" : "border-transparent text-subtle"}`}
      type="button"
      role="tab"
      aria-selected={tab === "transactions"}
      onclick={() => (tab = "transactions")}>交易紀錄</button
    >
  </div>

  <div class={compact ? "" : "min-h-0 flex-1 overflow-y-auto px-5 pb-4"}>
    {#if tab === "holdings"}
      {#if positions.length === 0}
        <p class="py-8 text-center text-sm text-subtle">尚無投資持倉。</p>
      {:else}
        <InvestmentHoldings {positions} {rates} />
      {/if}
    {:else}
      {#if tradesPending}
        <p class="py-8 text-center text-sm text-subtle">正在載入交易紀錄。</p>
      {:else if tradesError}
        <p class="py-8 text-center text-sm text-coral">
          交易紀錄暫時無法載入。
        </p>
      {:else if trades.length === 0}
        <p class="py-8 text-center text-sm text-subtle">尚無交易紀錄。</p>
      {:else}
        <div class="divide-y divide-border">
          {#each trades.slice(0, 100) as trade (trade.id)}
            {@const pnl = tradeRealizedPnl(trade)}
            <div
              class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3"
            >
              <div class="min-w-0">
                <p class="break-words text-sm font-semibold">
                  {trade.name ?? trade.symbol ?? "投資交易"}
                </p>
                <p class="mt-1 text-caption text-subtle">
                  {tradeSummary(trade)}
                </p>
              </div>
              <div class="text-right">
                <p class="text-sm font-semibold tabular-nums">
                  {tradeAmountText(trade)}
                </p>
                {#if pnl}
                  <p
                    class={`mt-1 text-caption tabular-nums ${pnlClass[pnl.tone]}`}
                  >
                    {pnl.text}
                  </p>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
