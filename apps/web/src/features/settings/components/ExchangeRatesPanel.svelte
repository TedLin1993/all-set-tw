<script lang="ts">
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { RefreshCw } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { messageFromError } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import { exchangeRatesQuery } from "@/data/assets/queries";
  import type { ExchangeRateRow } from "@/data/assets/types";
  import { formatDateTime } from "@/shared/format/financial";

  const EXCHANGE_RATE_SOURCE_URL = "https://www.exchangerate-api.com";
  const currencies = ["USD", "JPY", "EUR"] as const;
  const currencyLabels: Record<(typeof currencies)[number], string> = {
    USD: "美元",
    JPY: "日圓",
    EUR: "歐元",
  };

  let {
    api,
    demoMode = false,
    variant = "default",
  }: {
    api: ApiClient;
    demoMode?: boolean;
    variant?: "default" | "desktop";
  } = $props();

  const rates = createQuery(exchangeRatesQuery(() => api));
  const queryClient = useQueryClient();
  const refresh = createMutation({
    mutationFn: () =>
      api.post<ExchangeRateRow[]>("/api/exchange-rates/refresh"),
    onSuccess: (data) =>
      queryClient.setQueryData(queryKeys.exchangeRates, data),
  });

  const lastUpdatedAt = $derived(
    ($rates.data ?? []).find((rate) => rate.updatedAt)?.updatedAt,
  );

  function rateFor(currency: (typeof currencies)[number]) {
    return ($rates.data ?? []).find((rate) => rate.currency === currency);
  }

  function displayRate(rate: ExchangeRateRow | undefined) {
    return rate ? rate.rateTwd.toFixed(2) : "尚未取得";
  }
</script>

{#if variant === "desktop"}
  <Card as="section" class="overflow-hidden border-border shadow-xs">
    <CardHeader
      class="flex-row flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border bg-muted/60"
    >
      <div class="min-w-0">
        <h2 class="text-base font-bold">匯率</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          目前支援美元、日圓與歐元，供資產與活動換算使用。
        </p>
      </div>
      <div class="flex flex-wrap items-start justify-end gap-x-4 gap-y-2">
        <div class="text-right text-sm text-muted-foreground">
          <p>
            資料來源：<a
              class="font-semibold text-steel underline underline-offset-2"
              href={EXCHANGE_RATE_SOURCE_URL}
              target="_blank"
              rel="noreferrer">Rates By Exchange Rate API</a
            >
          </p>
          <p>
            最後更新：{lastUpdatedAt
              ? formatDateTime(lastUpdatedAt)
              : "尚未更新"}
          </p>
          {#if $refresh.error}
            <p role="alert" class="text-coral">
              {messageFromError($refresh.error)} 目前仍保留原有匯率。
            </p>
          {/if}
        </div>
        <Button
          variant="primary"
          disabled={demoMode || $refresh.isPending}
          onclick={() => $refresh.mutate()}
        >
          <RefreshCw
            class={$refresh.isPending ? "size-4 animate-spin" : "size-4"}
          />{$refresh.isPending ? "更新中…" : "更新匯率"}
        </Button>
      </div>
    </CardHeader>
    <CardContent class="p-0">
      <div
        class="hidden grid-cols-[minmax(0,1fr)_180px_1fr] bg-muted/60 text-sm font-semibold text-muted-foreground sm:grid"
      >
        <span class="px-4 py-3">幣別</span>
        <span class="px-4 py-3">換算率</span>
        <span class="px-4 py-3">說明</span>
      </div>
      {#each currencies as currency (currency)}
        {@const rate = rateFor(currency)}
        <div
          class="grid gap-1 border-t border-border px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_180px_1fr] sm:items-center sm:gap-0"
        >
          <span class="font-semibold"
            >{currencyLabels[currency]}（{currency}）</span
          >
          <span class="font-mono text-right sm:text-left"
            >1 {currency} = NT$ {displayRate(rate)}</span
          >
          <span class="text-sm text-muted-foreground"
            >1 {currency} 換算為新台幣</span
          >
        </div>
      {/each}
    </CardContent>
  </Card>
{:else}
  <Card>
    <CardHeader class="gap-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">匯率</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            供資產與活動換算使用的參考匯率。
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={demoMode || $refresh.isPending}
          onclick={() => $refresh.mutate()}
        >
          <RefreshCw
            class={$refresh.isPending ? "size-4 animate-spin" : "size-4"}
          />{$refresh.isPending ? "更新中…" : "更新"}
        </Button>
      </div>
    </CardHeader>
    <CardContent>
      <div class="grid gap-3">
        {#each currencies as currency (currency)}
          {@const rate = rateFor(currency)}
          <div class="flex items-center justify-between gap-3 text-sm">
            <span class="font-semibold"
              >{currencyLabels[currency]}（{currency}）</span
            >
            <span class="font-mono">1 {currency} = NT$ {displayRate(rate)}</span
            >
          </div>
        {/each}
      </div>
      <div
        class="mt-4 grid gap-1 border-t border-border pt-3 text-sm text-muted-foreground"
      >
        <p>
          資料來源：<a
            class="font-semibold text-steel underline underline-offset-2"
            href={EXCHANGE_RATE_SOURCE_URL}
            target="_blank"
            rel="noreferrer">Rates By Exchange Rate API</a
          >
        </p>
        <p>
          最後更新：{lastUpdatedAt ? formatDateTime(lastUpdatedAt) : "尚未更新"}
        </p>
        {#if $refresh.error}
          <p role="alert" class="text-coral">
            {messageFromError($refresh.error)} 目前仍保留原有匯率。
          </p>
        {/if}
      </div>
    </CardContent>
  </Card>
{/if}
