<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { ChevronRight, Pencil, Plus, Trash2 } from "@lucide/svelte";
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
  import { isSettledManualAsset } from "./model/summary";
  import {
    formatCurrency,
    formatDate,
    todayStr,
  } from "@/shared/format/financial";

  let {
    api,
    variant = "page",
    hideSummary = false,
  }: {
    api: ApiClient;
    variant?: "page" | "embedded";
    hideSummary?: boolean;
  } = $props();
  const qc = useQueryClient();
  const assets = createQuery(() => manualAssetsQuery(() => api));
  const rates = createQuery(() => exchangeRatesQuery(() => api));
  let adding = $state(false);
  let editing = $state<ManualAssetRow | null>(null);
  let expandedAssetId = $state<string | null>(null);
  let historyValue = $state("");
  let historyDate = $state(todayStr());
  let editingHistoryDate = $state<string | null>(null);
  let editingHistoryValue = $state("");
  let deletingAsset = $state<ManualAssetRow | null>(null);
  let deletingHistory = $state<{
    assetId: string;
    assetName: string;
    date: string;
  } | null>(null);
  let showSettled = $state(false);
  let formError = $state("");
  let editorDialog = $state<HTMLDivElement>();
  let deleteDialog = $state<HTMLDivElement>();
  let returnFocus: HTMLElement | null = null;
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
  const activeAssets = $derived(
    (assets.data ?? []).filter((asset) => !isSettledManualAsset(asset)),
  );
  const settledAssets = $derived(
    (assets.data ?? []).filter(isSettledManualAsset),
  );
  // type="number" 的輸入清空後是 null、未輸入時是空字串；0 是有效估值（例如投資到期回收）。
  const hasAmount = (value: string | number | null | undefined) =>
    value !== "" && value != null && Number.isFinite(Number(value));
  const rateValues = $derived(
    Object.fromEntries(
      (rates.data ?? []).map((rate) => [rate.currency, rate.rateTwd]),
    ),
  );
  const toTwd = (value: number, currency: string) =>
    currency === "TWD" ? value : value * (rateValues[currency] ?? 0);
  const total = $derived(
    (assets.data ?? []).reduce(
      (sum, asset) => sum + toTwd(asset.value ?? 0, asset.currency),
      0,
    ),
  );

  const add = createMutation(() => ({
    mutationFn: () =>
      api.post<{ id: string }>("/api/manual-assets", {
        ...form,
        value: Number(form.value),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.manualAssets });
      qc.invalidateQueries({ queryKey: queryKeys.netWorthHistory });
      closeEditor();
    },
  }));
  const update = createMutation(() => ({
    mutationFn: () =>
      api.put(`/api/manual-assets/${editing!.id}`, {
        name: form.name,
        category: form.category,
        currency: form.currency,
        note: form.note || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.manualAssets });
      qc.invalidateQueries({ queryKey: queryKeys.netWorthHistory });
      closeEditor();
    },
  }));
  const remove = createMutation(() => ({
    mutationFn: (id: string) => api.delete(`/api/manual-assets/${id}`),
    onSuccess: (_data, id) => {
      if (expandedAssetId === id) expandedAssetId = null;
      qc.invalidateQueries({ queryKey: queryKeys.manualAssets });
      qc.invalidateQueries({ queryKey: queryKeys.netWorthHistory });
      closeDeleteConfirmation();
    },
  }));
  const history = createQuery(() =>
    manualAssetHistoryQuery(() => api, expandedAssetId),
  );
  const addHistory = createMutation(() => ({
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
  }));
  const editHistory = createMutation(() => ({
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
  }));
  const deleteHistory = createMutation(() => ({
    mutationFn: ({ assetId, date }: { assetId: string; date: string }) =>
      api.delete(`/api/manual-assets/${assetId}/history/${date}`),
    onSuccess: () => {
      invalidateHistory();
      closeDeleteConfirmation();
    },
  }));

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
  function rememberFocus() {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }
  async function focusFirstControl(dialog: "editor" | "delete") {
    await tick();
    const element = dialog === "editor" ? editorDialog : deleteDialog;
    element
      ?.querySelector<HTMLElement>(
        dialog === "editor"
          ? "input:not([type='hidden']), select, textarea"
          : "button",
      )
      ?.focus();
  }
  function restoreFocus() {
    const target = returnFocus;
    returnFocus = null;
    void tick().then(() => target?.focus());
  }
  export function openAdd() {
    rememberFocus();
    adding = true;
    editing = null;
    reset();
    void focusFirstControl("editor");
  }
  function closeEditor() {
    adding = false;
    editing = null;
    reset();
    restoreFocus();
  }
  function startEdit(asset: ManualAssetRow) {
    rememberFocus();
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
    void focusFirstControl("editor");
  }
  function requestDeleteAsset(asset: ManualAssetRow) {
    rememberFocus();
    deletingAsset = asset;
    void focusFirstControl("delete");
  }
  function requestDeleteHistory(
    assetId: string,
    assetName: string,
    date: string,
  ) {
    rememberFocus();
    deletingHistory = { assetId, assetName, date };
    void focusFirstControl("delete");
  }
  function closeDeleteConfirmation() {
    deletingAsset = null;
    deletingHistory = null;
    restoreFocus();
  }
  function submit() {
    if (!form.name.trim()) {
      formError = "請輸入資產名稱。";
      return;
    }
    // 編輯只改基本資料；估值在展開區更新，才會留下估值歷史。
    if (!editing && !hasAmount(form.value)) {
      formError = "請輸入資產名稱與目前估值。";
      return;
    }
    formError = "";
    if (editing) update.mutate();
    else add.mutate();
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
  // 展開中的資產收進收合的「已結清」後就看不到了，一併清掉展開狀態，
  // 否則之後打開「已結清」時它會自己展開著。
  $effect(() => {
    if (
      !showSettled &&
      settledAssets.some((asset) => asset.id === expandedAssetId)
    )
      expandedAssetId = null;
  });

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deletingAsset || deletingHistory) closeDeleteConfirmation();
      else if (adding || editing) closeEditor();
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  $effect(() => {
    if (!adding && !editing && !deletingAsset && !deletingHistory) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  });
</script>

{#if assets.isPending}
  <EmptyState title="載入其他資產中" body="正在讀取估值紀錄。" />
{:else}
  <div
    class={hideSummary
      ? ""
      : variant === "embedded"
        ? "grid gap-3"
        : "grid gap-5"}
  >
    {#if !hideSummary}
      <div
        class={`flex flex-wrap items-end justify-between gap-3 ${variant === "embedded" ? "px-4 pt-4" : ""}`}
      >
        <div>
          <p class="text-sm text-subtle">其他資產總額</p>
          <p
            class={`mt-1 font-semibold tracking-tight tabular-nums ${variant === "embedded" ? "text-xl" : "text-3xl"}`}
          >
            {formatCurrency(total)}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button variant="primary" onclick={openAdd}
            ><Plus class="size-4" />新增資產</Button
          >
        </div>
      </div>
    {/if}
    <Card class="border-0 bg-transparent shadow-none">
      {#if !hideSummary}
        <CardHeader class={variant === "embedded" ? "px-4" : ""}
          ><h2 class="text-lg font-semibold">
            {variant === "embedded" ? "資產與估值" : "資產清單"}
          </h2></CardHeader
        >
      {/if}
      <CardContent class="p-0">
        <div class="divide-y divide-ink/8">
          {#if (assets.data ?? []).length === 0}
            <p class="p-8 text-center text-sm text-subtle">尚無其他資產。</p>
          {:else}
            {#snippet assetRow(asset: ManualAssetRow)}
              {@const expanded = expandedAssetId === asset.id}
              <div class={hideSummary ? "" : "px-5 py-4"}>
                <button
                  class="grid min-h-[72px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 py-2 text-left transition hover:bg-ink/3"
                  onclick={() => toggleHistory(asset.id)}
                  aria-expanded={expanded}
                  aria-label={`${asset.name}，估值歷史`}
                >
                  <span class="min-w-0">
                    <strong class="block truncate text-sm">{asset.name}</strong>
                    <small class="mt-1 block truncate text-caption text-subtle">
                      {categories[asset.category as keyof typeof categories] ??
                        asset.category} · {asset.currency} · {asset.date
                        ? formatDate(asset.date)
                        : "尚未估值"}
                    </small>
                    {#if asset.note && !expanded}
                      <small
                        class="mt-1 line-clamp-2 text-caption break-words whitespace-pre-line text-subtle"
                      >
                        {asset.note}
                      </small>
                    {/if}
                  </span>
                  <strong class="text-sm font-medium tabular-nums">
                    {formatCurrency(asset.value ?? 0, asset.currency)}
                  </strong>
                  <ChevronRight
                    class={`size-4 text-subtle transition ${expanded ? "rotate-90" : ""}`}
                  />
                </button>
                {#if expanded}
                  <div class="mt-2 rounded-lg bg-paper/70 p-3">
                    {#if asset.note}
                      <p
                        class="mb-3 border-b border-ink/8 pb-3 text-sm leading-6 break-words whitespace-pre-line text-subtle"
                      >
                        {asset.note}
                      </p>
                    {/if}
                    <div class="flex flex-wrap items-end gap-2">
                      <label class="grid gap-1 text-caption text-subtle"
                        >估值（{asset.currency}）<Input
                          class="w-32"
                          type="number"
                          inputmode="decimal"
                          bind:value={historyValue}
                        /></label
                      ><label class="grid gap-1 text-caption text-subtle"
                        >日期<Input
                          type="date"
                          bind:value={historyDate}
                        /></label
                      ><Button
                        disabled={!hasAmount(historyValue) ||
                          addHistory.isPending}
                        onclick={() =>
                          addHistory.mutate({
                            assetId: asset.id,
                            value: Number(historyValue),
                            date: historyDate,
                          })}>更新估值</Button
                      >
                    </div>
                    <div
                      class="mt-4 flex items-center justify-between border-t border-ink/8 pt-3"
                    >
                      <h3 class="text-sm font-semibold">估值歷史</h3>
                      <span class="text-caption text-subtle"
                        >{(history.data ?? []).length} 筆</span
                      >
                    </div>
                    {#if history.isPending}<p class="mt-3 text-sm text-subtle">
                        載入歷史中…
                      </p>{:else if (history.data ?? []).length === 0}<p
                        class="mt-3 text-sm text-subtle"
                      >
                        尚無歷史紀錄。
                      </p>{:else}
                      <div class="mt-2 divide-y divide-ink/8">
                        {#each history.data ?? [] as entry (entry.date)}
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
                                  inputmode="decimal"
                                  bind:value={editingHistoryValue}
                                /><Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={!hasAmount(editingHistoryValue)}
                                  onclick={() =>
                                    editHistory.mutate({
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
                                <span class="font-medium tabular-nums"
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
                                    requestDeleteHistory(
                                      asset.id,
                                      asset.name,
                                      entry.date,
                                    )}>刪除</Button
                                >
                              </div>{/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                    <div
                      class="mt-3 flex items-center justify-between gap-2 border-t border-ink/8 pt-3"
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        onclick={() => startEdit(asset)}
                        ><Pencil class="size-4" />編輯資產</Button
                      ><Button
                        class="text-coral hover:text-coral"
                        size="sm"
                        variant="ghost"
                        onclick={() => requestDeleteAsset(asset)}
                        ><Trash2 class="size-4" />刪除資產</Button
                      >
                    </div>
                  </div>
                {/if}
              </div>
            {/snippet}
            {#each activeAssets as asset (asset.id)}
              {@render assetRow(asset)}
            {/each}
            {#if settledAssets.length > 0}
              <button
                class={`flex w-full cursor-pointer items-center gap-2 py-3 text-left text-sm text-subtle transition hover:bg-ink/3 ${hideSummary ? "" : "px-5"}`}
                aria-expanded={showSettled}
                onclick={() => (showSettled = !showSettled)}
              >
                <ChevronRight
                  class={`size-4 transition ${showSettled ? "rotate-90" : ""}`}
                />
                已結清（{settledAssets.length}）
              </button>
              {#if showSettled}
                {#each settledAssets as asset (asset.id)}
                  {@render assetRow(asset)}
                {/each}
              {/if}
            {/if}
          {/if}
        </div>
      </CardContent>
    </Card>
    {#if adding || editing}<div
        class="fixed inset-0 z-[70] flex items-end bg-inverse/45 md:items-center md:justify-center md:p-6"
      >
        <div
          aria-labelledby="manual-asset-editor-title"
          aria-modal="true"
          bind:this={editorDialog}
          class="w-full rounded-t-2xl bg-card p-5 shadow-2xl md:max-w-lg md:rounded-2xl"
          role="dialog"
          tabindex="-1"
        >
          <div class="flex items-center justify-between">
            <h2 id="manual-asset-editor-title" class="text-xl font-semibold">
              {editing ? "編輯資產" : "新增資產"}
            </h2>
            <Button
              aria-label="關閉"
              class="rounded-full text-xl"
              size="icon"
              variant="ghost"
              onclick={closeEditor}>×</Button
            >
          </div>
          <div class="mt-5 grid gap-3">
            <label class="grid gap-1 text-sm"
              >名稱<Input required bind:value={form.name} /></label
            >
            <div class="grid grid-cols-2 gap-3">
              <label class="grid gap-1 text-sm"
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
              >
            </div>
            {#if !editing}
              <div class="grid grid-cols-2 gap-3">
                <label class="grid gap-1 text-sm"
                  >目前估值<Input
                    required
                    type="number"
                    inputmode="decimal"
                    bind:value={form.value}
                  /></label
                ><label class="grid gap-1 text-sm"
                  >估值日期<Input type="date" bind:value={form.date} /></label
                >
              </div>
            {/if}
            <label class="grid gap-1 text-sm"
              >備註<Textarea rows="3" bind:value={form.note} /></label
            >
            {#if formError}<p
                class="text-sm font-medium text-coral"
                role="alert"
              >
                {formError}
              </p>{/if}
          </div>
          <div class="mt-5 grid grid-cols-2 gap-3">
            <Button variant="secondary" onclick={closeEditor}>取消</Button
            ><Button
              disabled={add.isPending || update.isPending}
              onclick={submit}
              >{add.isPending || update.isPending ? "儲存中…" : "儲存"}</Button
            >
          </div>
        </div>
      </div>{/if}
    {#if deletingAsset || deletingHistory}<div
        class="fixed inset-0 z-[80] flex items-center justify-center bg-inverse/45 p-5"
      >
        <div
          aria-labelledby="delete-confirmation-title"
          aria-modal="true"
          bind:this={deleteDialog}
          class="w-full max-w-sm rounded-2xl bg-card p-5 shadow-2xl"
          role="dialog"
          tabindex="-1"
        >
          <h2 id="delete-confirmation-title" class="text-lg font-semibold">
            {deletingAsset ? "確定刪除資產？" : "確定刪除估值？"}
          </h2>
          <p class="mt-2 text-sm leading-6 text-subtle">
            {#if deletingAsset}
              「{deletingAsset.name}」與全部估值歷史將永久刪除，無法復原。
            {:else if deletingHistory}
              「{deletingHistory.assetName}」在 {formatDate(
                deletingHistory.date,
              )} 的估值將永久刪除，無法復原。
            {/if}
          </p>
          <div class="mt-5 grid grid-cols-2 gap-3">
            <Button
              variant="secondary"
              disabled={remove.isPending || deleteHistory.isPending}
              onclick={closeDeleteConfirmation}>取消</Button
            ><Button
              class="bg-coral text-white hover:bg-coral/90"
              disabled={remove.isPending || deleteHistory.isPending}
              onclick={() => {
                if (deletingAsset) remove.mutate(deletingAsset.id);
                else if (deletingHistory)
                  deleteHistory.mutate({
                    assetId: deletingHistory.assetId,
                    date: deletingHistory.date,
                  });
              }}
              >{remove.isPending || deleteHistory.isPending
                ? "刪除中…"
                : "確認刪除"}</Button
            >
          </div>
        </div>
      </div>{/if}
  </div>
{/if}
