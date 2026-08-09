<script lang="ts">
  import type {
    InvestmentRow,
    InvestmentTransactionRow,
  } from "@/data/investments/types";
  import {
    formatCurrency,
    formatDate,
    formatNumber,
  } from "@/shared/format/financial";

  let {
    positions,
    trades,
    total,
    tradesPending = false,
    tradesError = false,
    compact = false,
  }: {
    positions: InvestmentRow[];
    trades: InvestmentTransactionRow[];
    total: number;
    tradesPending?: boolean;
    tradesError?: boolean;
    compact?: boolean;
  } = $props();

  let tab = $state<"holdings" | "transactions">("holdings");

  function tradeDisplay(trade: InvestmentTransactionRow) {
    if (trade.amount != null && trade.price != null && trade.price !== 1)
      return formatCurrency(trade.amount, trade.currency);
    if (trade.quantity != null) return `${formatNumber(trade.quantity)} 股`;
    return "金額未提供";
  }
</script>

<div class={compact ? "grid gap-3" : "flex min-h-full flex-col"}>
  {#if !compact}
    <header class="border-b border-border px-5 py-4">
      <p class="text-xs font-semibold text-muted-foreground">投資</p>
      <h2 class="mt-1 text-xl font-semibold tracking-tight">投資工作區</h2>
      <p class="mt-1 text-xs text-muted-foreground">持倉與交易紀錄集中查看</p>
    </header>
    <div class="grid grid-cols-2 gap-2 border-b border-border p-4">
      <div class="rounded-lg border border-border bg-paper p-3">
        <p class="text-xs text-muted-foreground">投資市值</p>
        <p class="mt-1 text-lg font-bold tabular-nums text-steel">
          {formatCurrency(total)}
        </p>
      </div>
      <div class="rounded-lg border border-border bg-paper p-3">
        <p class="text-xs text-muted-foreground">持倉</p>
        <p class="mt-1 text-lg font-bold tabular-nums">{positions.length} 筆</p>
      </div>
    </div>
  {/if}

  <div
    class="flex gap-1 border-b border-border px-4 pt-2"
    role="tablist"
    aria-label="投資工作區"
  >
    <button
      class={`min-h-10 border-b-2 px-3 text-sm font-semibold ${tab === "holdings" ? "border-steel text-ink" : "border-transparent text-muted-foreground"}`}
      type="button"
      role="tab"
      aria-selected={tab === "holdings"}
      onclick={() => (tab = "holdings")}>持倉</button
    >
    <button
      class={`min-h-10 border-b-2 px-3 text-sm font-semibold ${tab === "transactions" ? "border-steel text-ink" : "border-transparent text-muted-foreground"}`}
      type="button"
      role="tab"
      aria-selected={tab === "transactions"}
      onclick={() => (tab = "transactions")}>交易紀錄</button
    >
  </div>

  <div class={compact ? "" : "min-h-0 flex-1 overflow-y-auto px-5 pb-4"}>
    {#if tab === "holdings"}
      {#if positions.length === 0}
        <p class="py-8 text-center text-sm text-muted-foreground">
          尚無投資持倉。
        </p>
      {:else}
        <div class="divide-y divide-border">
          {#each positions as position (position.id)}
            <div
              class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3"
            >
              <div class="min-w-0">
                <p class="break-words text-sm font-semibold">
                  {position.symbol ? `${position.symbol} ` : ""}{position.name}
                </p>
                <p class="mt-1 text-xs text-muted-foreground">
                  {position.assetType.toUpperCase()} · {position.currency} ·
                  {formatNumber(position.quantity ?? 0)} 單位
                </p>
              </div>
              <p class="text-right text-sm font-bold tabular-nums text-steel">
                {formatCurrency(
                  (position.marketValue ?? 0) + (position.cashBalance ?? 0),
                  position.currency,
                )}
              </p>
            </div>
          {/each}
        </div>
      {/if}
    {:else if tradesPending}
      <p class="py-8 text-center text-sm text-muted-foreground">
        正在載入交易紀錄。
      </p>
    {:else if tradesError}
      <p class="py-8 text-center text-sm text-coral">交易紀錄暫時無法載入。</p>
    {:else if trades.length === 0}
      <p class="py-8 text-center text-sm text-muted-foreground">
        尚無交易紀錄。
      </p>
    {:else}
      <div class="divide-y divide-border">
        {#each trades.slice(0, 100) as trade (trade.id)}
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3"
          >
            <div class="min-w-0">
              <p class="break-words text-sm font-semibold">
                {trade.name ?? trade.symbol ?? "投資交易"}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                {trade.transactionName ?? trade.transactionCode ?? "交易"} ·
                {formatDate(trade.tradeDate ?? trade.postedDate)}
              </p>
            </div>
            <p class="text-right text-sm font-semibold">
              {tradeDisplay(trade)}
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
