<script lang="ts">
  import type { InvestmentRow } from "@/data/investments/types";
  import { listedHoldingCount } from "@/data/investments/holding-groups";
  import { formatCurrency } from "@/shared/format/financial";
  import InvestmentHoldings from "./InvestmentHoldings.svelte";

  let {
    positions,
    rates,
    total,
  }: {
    positions: InvestmentRow[];
    rates: Readonly<Record<string, number>>;
    total: number;
  } = $props();
</script>

<div class="flex min-h-full flex-col">
  <header class="border-b border-ink/10 px-5 py-4">
    <p class="text-caption font-medium text-subtle">加密貨幣</p>
    <h2 class="mt-1 text-xl font-semibold tracking-tight">交易所持倉</h2>
    <p class="mt-1 text-caption text-subtle">
      只同步持倉，以同步當下的報價換算台幣
    </p>
  </header>
  <div class="grid grid-cols-2 gap-6 border-b border-ink/10 px-5 py-4">
    <div>
      <p class="text-caption text-subtle">台幣估值</p>
      <p
        class={`mt-2 text-lg font-medium tabular-nums ${total < 0 ? "text-coral" : "text-steel"}`}
      >
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
  <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
    <InvestmentHoldings {positions} {rates} grouped />
  </div>
</div>
