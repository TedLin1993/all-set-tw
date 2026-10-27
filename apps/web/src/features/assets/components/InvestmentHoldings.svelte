<script lang="ts">
  import { ChevronRight } from "@lucide/svelte";
  import type { InvestmentRow } from "@/data/investments/types";
  import { formatCurrency } from "@/shared/format/financial";
  import {
    groupInvestmentPositions,
    holdingTitle,
    type InvestmentHolding,
  } from "@/data/investments/holding-groups";
  import {
    formatPositionQuantity,
    positionAssetTypeLabel,
  } from "../model/investment-display";

  let {
    positions,
    rates,
    expandAll = false,
  }: {
    positions: InvestmentRow[];
    rates: Readonly<Record<string, number>>;
    /** 搜尋時展開全部，讓符合的持倉直接可見。 */
    expandAll?: boolean;
  } = $props();

  const institutions = $derived(groupInvestmentPositions(positions, rates));
  // 預設全部收合，與金融機構區塊一致。
  let expanded = $state<Set<string>>(new Set());

  function isOpen(key: string) {
    return expandAll || expanded.has(key);
  }

  function toggle(key: string) {
    // 搜尋時全部展開，點擊不改變展開狀態，避免清除搜尋後殘留。
    if (expandAll) return;
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  function holdingDetail({ row }: InvestmentHolding) {
    if (row.assetType === "crypto") {
      if (row.sourceId.startsWith("futures-"))
        return "合約 · 帳戶權益，含未實現損益";
      if (row.sourceId.startsWith("wallet-")) return "帳戶總值";
      if (row.quantity == null) return "";
      return `${formatPositionQuantity(row)} ${row.symbol ?? ""}`.trim();
    }
    if (row.quantity == null) return positionAssetTypeLabel(row.assetType);
    return `${positionAssetTypeLabel(row.assetType)} · ${formatPositionQuantity(row)} 單位`;
  }
</script>

{#snippet holdingList(holdings: InvestmentHolding[])}
  <div class="divide-y divide-ink/8">
    {#each holdings as holding (holding.row.id)}
      <div
        class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5"
      >
        <div class="min-w-0">
          <p class="break-words text-sm font-semibold">
            {holdingTitle(holding.row)}
          </p>
          <p class="mt-0.5 text-caption text-subtle">
            {holdingDetail(holding)}
          </p>
        </div>
        <p
          class={`text-right text-sm font-medium tabular-nums ${holding.valueTwd !== null && holding.valueTwd < 0 ? "text-coral" : "text-steel"}`}
        >
          {holding.row.marketValue == null && holding.row.cashBalance == null
            ? "無法估值"
            : formatCurrency(
                (holding.row.marketValue ?? 0) + (holding.row.cashBalance ?? 0),
                holding.row.currency,
              )}
        </p>
      </div>
    {/each}
  </div>
{/snippet}

<div class="divide-y divide-ink/10">
  {#each institutions as institution (institution.key)}
    <div>
      <button
        class="grid min-h-[64px] w-full grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 py-2 text-left"
        type="button"
        aria-expanded={isOpen(institution.key)}
        onclick={() => toggle(institution.key)}
      >
        <span class="min-w-0">
          <strong class="block truncate text-sm">{institution.label}</strong>
          <small class="mt-1 block truncate text-caption text-subtle">
            {institution.visibleCount
              ? `${institution.visibleCount} 筆持倉${institution.hiddenCount ? ` · 另有 ${institution.hiddenCount} 筆小額未顯示` : ""}`
              : institution.hiddenCount
                ? `${institution.hiddenCount} 筆小額持倉未顯示`
                : "目前沒有持倉"}
          </small>
        </span>
        <strong
          class={`text-right text-sm tabular-nums ${institution.totalTwd < 0 ? "text-coral" : "text-steel"}`}
        >
          {formatCurrency(institution.totalTwd)}
        </strong>
        <ChevronRight
          class={`size-4 text-subtle transition ${isOpen(institution.key) ? "rotate-90" : ""}`}
        />
      </button>
      {#if isOpen(institution.key)}
        <div class="border-t border-ink/8 pb-3 pl-4">
          {#if institution.holdings.length === 0}
            <p class="py-3 text-sm text-subtle">
              {institution.hiddenCount
                ? "所有持倉都低於 NT$10，未列出。"
                : "目前沒有持倉。"}
            </p>
          {:else}
            {@render holdingList(institution.holdings)}
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>
