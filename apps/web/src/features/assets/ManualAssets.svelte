<script lang="ts">
  import { toStore } from "svelte/store";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { Pencil, Plus, Trash2 } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import EmptyState from "@/shared/ui/EmptyState.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import Textarea from "@/shared/ui/Textarea.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import {
    exchangeRatesQuery,
    manualAssetHistoryQuery,
    manualAssetsQuery,
  } from "@/data/assets/queries";
  import type { ManualAssetRow } from "@/data/assets/types";
  import {
    formatCurrency,
    formatDate,
    todayStr,
  } from "@/shared/format/financial";

  let { api }: { api: ApiClient } = $props();
  const qc = useQueryClient();
  const assets = createQuery(manualAssetsQuery(() => api));
  const rates = createQuery(exchangeRatesQuery(() => api));
  let adding = $state(false);
  let editing = $state<ManualAssetRow | null>(null);
  let expandedAssetId = $state<string | null>(null);
  let historyValue = $state("");
  let historyDate = $state(todayStr());
  let editingHistoryDate = $state<string | null>(null);
  let editingHistoryValue = $state("");
  let formError = $state("");
  let form = $state({
    name: "",
    category: "real_estate",
    currency: "TWD",
    value: "",
    date: todayStr(),
    note: "",
  });
  const categories = {
    real_estate: "不動產",
    insurance: "保險",
    vehicle: "交通工具",
    other: "其他",
  };
  const currencies = ["TWD", "USD", "JPY", "EUR"] as const;
  const rateValues = $derived(
    Object.fromEntries(
      ($rates.data ?? []).map((rate) => [rate.currency, rate.rateTwd]),
    ),
  );
  const toTwd = (value: number, currency: string) =>
    currency === "TWD" ? value : value * (rateValues[currency] ?? 0);
  const total = $derived(
    ($assets.data ?? []).reduce(
      (sum, asset) => sum + toTwd(asset.value ?? 0, asset.currency),
      0,
    ),
  );

  const add = createMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/api/manual-assets", {
        ...form,
        value: Number(form.value),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.manualAssets });
      qc.invalidateQueries({ queryKey: queryKeys.netWorthHistory });
      adding = false;
      reset();
    },
  });
  const update = createMutation({
    mutationFn: () =>
      api.put(`/api/manual-assets/${editing!.id}`, {
        name: form.name,
        category: form.category,
        currency: form.currency,
        note: form.note || null,
        value: Number(form.value),
        date: form.date,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.manualAssets });
      qc.invalidateQueries({ queryKey: queryKeys.netWorthHistory });
      editing = null;
      reset();
    },
  });
  const remove = createMutation({
    mutationFn: (id: string) => api.delete(`/api/manual-assets/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.manualAssets });
      qc.invalidateQueries({ queryKey: queryKeys.netWorthHistory });
    },
  });
  const history = createQuery(
    toStore(() => manualAssetHistoryQuery(() => api, expandedAssetId)),
  );
  const addHistory = createMutation({
    mutationFn: ({
      assetId,
      value,
      date,
    }: {
      assetId: string;
      value: number;
      date: string;
    }) => api.post(`/api/manual-assets/${assetId}/history`, { value, date }),
    onSuccess: () => {
      invalidateHistory();
      historyValue = "";
      historyDate = todayStr();
    },
  });
  const editHistory = createMutation({
    mutationFn: ({
      assetId,
      value,
      date,
    }: {
      assetId: string;
      value: number;
      date: string;
    }) => api.post(`/api/manual-assets/${assetId}/history`, { value, date }),
    onSuccess: () => {
      invalidateHistory();
      editingHistoryDate = null;
      editingHistoryValue = "";
    },
  });
  const deleteHistory = createMutation({
    mutationFn: ({ assetId, date }: { assetId: string; date: string }) =>
      api.delete(`/api/manual-assets/${assetId}/history/${date}`),
    onSuccess: invalidateHistory,
  });

  function reset() {
    formError = "";
    form = {
      name: "",
      category: "real_estate",
      currency: "TWD",
      value: "",
      date: todayStr(),
      note: "",
    };
  }
  function startEdit(asset: ManualAssetRow) {
    formError = "";
    editing = asset;
    form = {
      name: asset.name,
      category: asset.category,
      currency: asset.currency,
      value: String(asset.value ?? ""),
      date: asset.date ?? todayStr(),
      note: asset.note ?? "",
    };
  }
  function submit() {
    if (!form.name.trim() || !form.value) {
      formError = "請輸入資產名稱與目前估值。";
      return;
    }
    formError = "";
    editing ? $update.mutate() : $add.mutate();
  }
  function invalidateHistory() {
    qc.invalidateQueries({ queryKey: queryKeys.manualAssets });
    qc.invalidateQueries({ queryKey: queryKeys.netWorthHistory });
    if (expandedAssetId)
      qc.invalidateQueries({
        queryKey: queryKeys.manualAssetHistory(expandedAssetId),
      });
  }
  function toggleHistory(id: string) {
    expandedAssetId = expandedAssetId === id ? null : id;
    historyValue = "";
    historyDate = todayStr();
    editingHistoryDate = null;
  }
</script>

{#if $assets.isPending}
  <EmptyState title="載入其他資產中" body="正在讀取估值紀錄。" />
{:else}
  <div class="grid gap-5">
    <div class="flex items-end justify-between">
      <div>
        <p class="text-sm text-ink/50">其他資產總額</p>
        <p class="mt-1 text-3xl font-bold">{formatCurrency(total)}</p>
      </div>
      <Button
        variant="primary"
        onclick={() => {
          adding = true;
          editing = null;
          reset();
        }}><Plus class="size-4" />新增資產</Button
      >
    </div>
    <Card>
      <CardHeader><h2 class="text-lg font-semibold">資產清單</h2></CardHeader>
      <CardContent class="p-0">
        <div class="divide-y divide-ink/8">
          {#if ($assets.data ?? []).length === 0}
            <p class="p-8 text-center text-sm text-ink/50">尚無其他資產。</p>
          {:else}
            {#each $assets.data ?? [] as asset (asset.id)}
              <div class="px-5 py-4">
                <div class="flex items-center justify-between gap-3">
                  <button
                    class="min-w-0 flex-1 text-left"
                    onclick={() => toggleHistory(asset.id)}
                    aria-expanded={expandedAssetId === asset.id}
                  >
                    <p class="truncate font-semibold">{asset.name}</p>
                    <p class="mt-1 text-xs text-ink/45">
                      {categories[asset.category as keyof typeof categories] ??
                        asset.category} · {asset.currency} · {asset.date
                        ? formatDate(asset.date)
                        : "尚未估值"}{asset.note ? ` · ${asset.note}` : ""}
                    </p>
                  </button>
                  <div class="flex items-center gap-3">
                    <p class="font-bold tabular-nums">
                      {formatCurrency(asset.value ?? 0, asset.currency)}
                    </p>
                    <button
                      class="rounded-sm p-1 text-ink/40 hover:text-steel"
                      aria-label="編輯資產"
                      onclick={() => startEdit(asset)}
                      ><Pencil class="size-4" /></button
                    ><button
                      class="rounded-sm p-1 text-ink/40 hover:text-coral"
                      aria-label="刪除資產"
                      onclick={() => $remove.mutate(asset.id)}
                      ><Trash2 class="size-4" /></button
                    >
                  </div>
                </div>
                {#if expandedAssetId === asset.id}
                  <div class="mt-4 rounded-lg bg-paper/70 p-3">
                    <div class="flex items-center justify-between">
                      <h3 class="text-sm font-semibold">估值歷史</h3>
                      <span class="text-xs text-ink/45"
                        >{($history.data ?? []).length} 筆</span
                      >
                    </div>
                    {#if $history.isPending}<p class="mt-3 text-sm text-ink/45">
                        載入歷史中…
                      </p>{:else if ($history.data ?? []).length === 0}<p
                        class="mt-3 text-sm text-ink/45"
                      >
                        尚無歷史紀錄。
                      </p>{:else}
                      <div class="mt-2 divide-y divide-ink/8">
                        {#each $history.data ?? [] as entry (entry.date)}
                          <div
                            class="flex items-center justify-between gap-3 py-2 text-sm"
                          >
                            <span>{formatDate(entry.date)}</span
                            >{#if editingHistoryDate === entry.date}<div
                                class="flex items-center gap-2"
                              >
                                <Input
                                  class="h-8 w-28 px-2 py-1"
                                  type="number"
                                  bind:value={editingHistoryValue}
                                /><Button
                                  size="sm"
                                  variant="ghost"
                                  onclick={() =>
                                    $editHistory.mutate({
                                      assetId: asset.id,
                                      value: Number(editingHistoryValue),
                                      date: entry.date,
                                    })}>儲存</Button
                                ><Button
                                  size="sm"
                                  variant="ghost"
                                  onclick={() => (editingHistoryDate = null)}
                                  >取消</Button
                                >
                              </div>{:else}<div class="flex items-center gap-2">
                                <span class="font-medium"
                                  >{formatCurrency(
                                    entry.value,
                                    asset.currency,
                                  )}</span
                                ><Button
                                  size="sm"
                                  variant="ghost"
                                  onclick={() => {
                                    editingHistoryDate = entry.date;
                                    editingHistoryValue = String(entry.value);
                                  }}>編輯</Button
                                ><Button
                                  class="text-coral hover:text-coral"
                                  size="sm"
                                  variant="ghost"
                                  onclick={() =>
                                    $deleteHistory.mutate({
                                      assetId: asset.id,
                                      date: entry.date,
                                    })}>刪除</Button
                                >
                              </div>{/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                    <div
                      class="mt-3 flex flex-wrap items-end gap-2 border-t border-ink/8 pt-3"
                    >
                      <label class="grid gap-1 text-xs text-ink/55"
                        >估值（{asset.currency}）<Input
                          class="w-32"
                          type="number"
                          bind:value={historyValue}
                        /></label
                      ><label class="grid gap-1 text-xs text-ink/55"
                        >日期<Input
                          type="date"
                          bind:value={historyDate}
                        /></label
                      ><Button
                        size="sm"
                        disabled={!historyValue || $addHistory.isPending}
                        onclick={() =>
                          $addHistory.mutate({
                            assetId: asset.id,
                            value: Number(historyValue),
                            date: historyDate,
                          })}><Plus class="size-4" />新增估值</Button
                      >
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </CardContent>
    </Card>
    {#if adding || editing}<div
        class="fixed inset-0 z-[70] flex items-end bg-ink/45 md:items-center md:justify-center md:p-6"
      >
        <div
          class="w-full rounded-t-2xl bg-white p-5 shadow-2xl md:max-w-lg md:rounded-2xl"
        >
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-semibold">
              {editing ? "編輯資產" : "新增資產"}
            </h2>
            <Button
              aria-label="關閉"
              class="rounded-full text-xl"
              size="icon"
              variant="ghost"
              onclick={() => {
                adding = false;
                editing = null;
              }}>×</Button
            >
          </div>
          <div class="mt-5 grid gap-3">
            <label class="grid gap-1 text-sm"
              >名稱<Input required bind:value={form.name} /></label
            ><label class="grid gap-1 text-sm"
              >類別<Select bind:value={form.category}
                >{#each Object.entries(categories) as [key, label] (key)}<option
                    value={key}>{label}</option
                  >{/each}</Select
              ></label
            ><label class="grid gap-1 text-sm"
              >幣別<Select bind:value={form.currency}
                >{#each currencies as currency (currency)}<option
                    value={currency}>{currency}</option
                  >{/each}</Select
              ></label
            ><label class="grid gap-1 text-sm"
              >目前估值<Input
                required
                type="number"
                bind:value={form.value}
              /></label
            ><label class="grid gap-1 text-sm"
              >估值日期<Input type="date" bind:value={form.date} /></label
            ><label class="grid gap-1 text-sm"
              >備註<Textarea rows="2" bind:value={form.note} /></label
            >
            {#if formError}<p
                class="text-sm font-medium text-coral"
                role="alert"
              >
                {formError}
              </p>{/if}
          </div>
          <div class="mt-5 grid grid-cols-2 gap-3">
            <Button
              variant="secondary"
              onclick={() => {
                adding = false;
                editing = null;
              }}>取消</Button
            ><Button
              disabled={$add.isPending || $update.isPending}
              onclick={submit}
              >{$add.isPending || $update.isPending
                ? "儲存中…"
                : "儲存"}</Button
            >
          </div>
        </div>
      </div>{/if}
  </div>
{/if}
