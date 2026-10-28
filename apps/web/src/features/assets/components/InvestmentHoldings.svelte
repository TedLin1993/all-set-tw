<script lang="ts">
  import type { InvestmentRow } from "@/data/investments/types";
  import { formatCurrency } from "@/shared/format/financial";
  import {
    groupInvestmentPositions,
    holdingTitle,
    listInvestmentHoldings,
    type InvestmentHolding,
  } from "@/data/investments/holding-groups";
  import {
    formatPositionQuantity,
    positionAssetTypeLabel,
  } from "../model/investment-display";

  let {
    positions,
    rates,
    grouped = false,
  }: {
    positions: InvestmentRow[];
    rates: Readonly<Record<string, number>>;
    /** 依資料來源分區（加密貨幣依交易所）；否則單一清單依市值排序。 */
    grouped?: boolean;
  } = $props();

  // 分區一律展開：使用者已從資產清冊選了這個大類，不再多一層點擊。
  const institutions = $derived(
    grouped ? groupInvestmentPositions(positions, rates) : [],
  );
  const flat = $derived(
    grouped ? undefined : listInvestmentHoldings(positions, rates),
  );

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

{#if flat}
  {@render holdingList(flat.holdings)}
  {#if flat.hiddenCount}
    <p class="border-t border-ink/8 py-3 text-caption text-subtle">
      另有 {flat.hiddenCount} 筆台幣估值低於 NT$10 的持倉未顯示，仍計入市值。
    </p>
  {/if}
{:else}
  <div class="divide-y divide-ink/10">
    {#each institutions as institution (institution.key)}
      <section aria-label={institution.label} class="pt-4 pb-1">
        <div class="flex items-start justify-between gap-3 pb-1">
          <div class="min-w-0">
            <h3 class="truncate text-sm font-semibold">{institution.label}</h3>
            <p class="mt-0.5 truncate text-caption text-subtle">
              {institution.visibleCount
                ? `${institution.visibleCount} 筆持倉${institution.hiddenCount ? ` · 另有 ${institution.hiddenCount} 筆小額未顯示` : ""}`
                : institution.hiddenCount
                  ? `${institution.hiddenCount} 筆小額持倉未顯示`
                  : "目前沒有持倉"}
            </p>
          </div>
          <strong
            class={`shrink-0 text-right text-sm tabular-nums ${institution.totalTwd < 0 ? "text-coral" : "text-steel"}`}
          >
            {formatCurrency(institution.totalTwd)}
          </strong>
        </div>
        {#if institution.holdings.length === 0}
          <p class="py-2 text-sm text-subtle">
            {institution.hiddenCount
              ? "所有持倉都低於 NT$10，未列出。"
              : "目前沒有持倉。"}
          </p>
        {:else}
          {@render holdingList(institution.holdings)}
        {/if}
      </section>
    {/each}
  </div>
{/if}
