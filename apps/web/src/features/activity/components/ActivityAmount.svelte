<script lang="ts">
  import type { ActivityItem } from "../model/types";
  import type { ExchangeRateRow } from "@/data/assets/types";
  import { activityAmountTwd, activityDisplayAmount } from "../model/chart";
  import { formatCurrency, formatDateTime } from "@/shared/format/financial";
  import { moneyState } from "@/shared/state/money-visibility.svelte";

  let {
    item,
    rates,
    exchangeRates = [],
    detail = false,
  }: {
    item: ActivityItem;
    rates: Record<string, number>;
    exchangeRates?: ExchangeRateRow[];
    detail?: boolean;
  } = $props();
  const original = $derived(activityDisplayAmount(item));
  const twd = $derived(activityAmountTwd(item, rates));
  const foreign = $derived(item.currency !== "TWD" && original != null);
  const rate = $derived(
    exchangeRates.find((entry) => entry.currency === item.currency),
  );
</script>

<span class="block" class:text-xs={original != null && twd == null}>
  {#if original == null}—
  {:else if moneyState.hidden}••••••
  {:else if twd == null}台幣金額暫無法換算
  {:else}{foreign ? "約 " : ""}{twd >= 0 && item.source !== "invoice"
      ? "+"
      : ""}{formatCurrency(twd)}{/if}
</span>
{#if foreign}
  <span class="mt-1 block text-xs font-normal text-ink/50"
    >原幣 {formatCurrency(original!, item.currency)}</span
  >
  {#if detail && twd != null && rate}
    <span class="mt-1 block whitespace-normal text-xs font-normal text-ink/50">
      1 {item.currency} = {new Intl.NumberFormat("zh-TW", {
        maximumSignificantDigits: 6,
      }).format(rate.rateTwd)} TWD<br />
      匯率更新：{formatDateTime(rate.updatedAt)}
    </span>
  {/if}
{/if}
