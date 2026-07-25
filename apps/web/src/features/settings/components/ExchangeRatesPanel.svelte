<script lang="ts">
  import { onMount } from "svelte";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { Save } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import { exchangeRatesQuery } from "@/data/assets/queries";
  import { bankQuery } from "@/data/bank/queries";
  import { formatDateTime } from "@/shared/format/financial";
  let {
    api,
    variant = "default",
  }: {
    api: ApiClient;
    variant?: "default" | "desktop";
  } = $props();
  const rates = createQuery(exchangeRatesQuery(() => api));
  const bank = createQuery(bankQuery(() => api));
  const qc = useQueryClient();
  let values = $state<Record<string, string>>({});
  const currencies = $derived([
    ...new Set(
      [
        ...($bank.data?.accounts ?? []).map((account) => account.currency),
        ...($rates.data ?? []).map((rate) => rate.currency),
      ].filter(
        (currency): currency is string =>
          Boolean(currency) && currency !== "TWD",
      ),
    ),
  ]);
  const save = createMutation({
    mutationFn: (payload: Record<string, number>) =>
      api.put("/api/exchange-rates", { rates: payload }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.exchangeRates }),
  });
  onMount(() =>
    rates.subscribe((result) => {
      for (const rate of result.data ?? []) {
        if (values[rate.currency] === undefined)
          values[rate.currency] = String(rate.rateTwd);
      }
    }),
  );
</script>

{#if variant === "desktop"}
  <Card as="section" class="overflow-hidden border-border shadow-xs">
    <CardHeader class="border-b border-border bg-muted/60">
      <div>
        <h2 class="text-base font-bold">匯率表格</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          可調整外幣換算使用的參考匯率。
        </p>
      </div>
    </CardHeader>
    <CardContent class="p-0">
      {#if currencies.length === 0}
        <p class="p-5 text-sm text-muted-foreground">目前沒有外幣帳戶。</p>
      {:else}
        <div
          class="hidden grid-cols-[minmax(0,1fr)_180px_220px_220px] bg-muted/60 text-sm font-semibold text-muted-foreground sm:grid"
        >
          <span class="px-4 py-3">幣別</span>
          <span class="px-4 py-3">換算率</span>
          <span class="px-4 py-3">來源</span>
          <span class="px-4 py-3">更新時間</span>
        </div>
        {#each currencies as currency (currency)}
          {@const rate = ($rates.data ?? []).find(
            (item) => item.currency === currency,
          )}
          <label
            class="grid gap-2 border-t border-border px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_180px_220px_220px] sm:items-center"
          >
            <span class="font-semibold">{currency}</span>
            <Input
              class="w-full text-right sm:w-32"
              type="number"
              step="0.0001"
              bind:value={values[currency]}
              aria-label={`${currency} 匯率`}
            />
            <span class="text-sm text-muted-foreground">手動設定</span>
            <span class="text-sm text-muted-foreground"
              >{rate?.updatedAt
                ? formatDateTime(rate.updatedAt)
                : "尚未更新"}</span
            >
          </label>
        {/each}
        <div class="border-t border-border p-4">
          <Button
            variant="primary"
            disabled={$save.isPending}
            onclick={() =>
              $save.mutate(
                Object.fromEntries(
                  Object.entries(values).map(([k, v]) => [k, Number(v)]),
                ),
              )}
            ><Save class="size-4" />{$save.isPending
              ? "儲存中…"
              : "儲存匯率"}</Button
          >
        </div>
      {/if}
    </CardContent>
  </Card>
{:else}
  <Card
    ><CardHeader
      ><h2 class="text-lg font-semibold">匯率</h2>
      <p class="text-sm text-muted-foreground">
        管理外幣換算使用的參考匯率
      </p></CardHeader
    ><CardContent
      ><div class="grid gap-3">
        {#if currencies.length === 0}<p class="text-sm text-muted-foreground">
            目前沒有外幣帳戶。
          </p>{:else}{#each currencies as currency (currency)}<label
              class="flex items-center justify-between gap-3 text-sm"
              ><span class="font-semibold">{currency}</span><Input
                class="w-32 text-right"
                type="number"
                step="0.0001"
                bind:value={values[currency]}
              /></label
            >{/each}<Button
            variant="primary"
            disabled={$save.isPending}
            onclick={() =>
              $save.mutate(
                Object.fromEntries(
                  Object.entries(values).map(([k, v]) => [k, Number(v)]),
                ),
              )}
            ><Save class="size-4" />{$save.isPending
              ? "儲存中…"
              : "儲存匯率"}</Button
          >{/if}
      </div></CardContent
    ></Card
  >
{/if}
