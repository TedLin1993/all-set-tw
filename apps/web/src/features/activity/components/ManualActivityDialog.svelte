<script lang="ts">
  // 手動記錄視窗：日期、支出／收入、分類、名稱、金額，另可選填外幣（原幣金額＋匯率）。
  // 新增走 POST /api/activity/manual；帶入 item（source === "manual"）＝編輯，走 PUT。
  import { untrack } from "svelte";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { X } from "@lucide/svelte";
  import { activityDateKey, type ActivityItem } from "@taiwan-fin-hub/shared";
  import type { ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import type { ExchangeRateRow } from "@/data/assets/types";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import {
    FX_CURRENCIES,
    buildManualActivityInput,
    fxToTwd,
    localDate,
    parseAmountText,
    type ManualActivityInput,
    type ManualKind,
  } from "../model/manual-form";

  let {
    api,
    categories,
    item = null,
    onClose,
    onSaved,
  }: {
    api: ApiClient;
    categories: { id: string; label: string }[];
    /** 帶入既有手動記錄＝編輯模式，否則為新增。 */
    item?: ActivityItem | null;
    onClose: () => void;
    onSaved: (message: string) => void;
  } = $props();

  const queryClient = useQueryClient();
  // 編輯目標在視窗生命週期內固定，只取初始值。
  const initial = untrack(() => item);
  const editing = initial !== null;
  const initialFx = initial?.manualFx ?? null;

  let kind = $state<ManualKind>(
    initial && (initial.amount ?? 0) > 0 ? "income" : "expense",
  );
  let categoryId = $state(initial?.categoryId ?? "");
  let name = $state(initial?.title ?? "");
  let date = $state(initial ? activityDateKey(initial) : localDate());
  let twdText = $state(
    initial?.amount != null ? String(Math.abs(initial.amount)) : "",
  );
  let fxCurrency = $state(initialFx?.currency ?? "");
  let fxAmountText = $state(initialFx ? String(initialFx.amount) : "");
  let fxRateText = $state(initialFx ? String(initialFx.rate) : "");
  // 台幣金額預設由「原幣 × 匯率」算出；使用者手動改過（或編輯既有記錄）後就不再覆寫。
  let twdTouched = $state(editing);
  let rateLoading = $state(false);
  let rateMissing = $state(false);
  let error = $state("");

  const autoTwd = $derived.by(() => {
    const amount = parseAmountText(fxAmountText);
    const rate = parseAmountText(fxRateText);
    return fxCurrency && amount >= 0 && rate > 0 ? fxToTwd(amount, rate) : null;
  });
  $effect(() => {
    if (fxCurrency && !twdTouched && autoTwd !== null)
      twdText = String(autoTwd);
  });

  async function readRate(currency: string) {
    const rows = await api.get<ExchangeRateRow[]>("/api/exchange-rates");
    return rows.find((row) => row.currency === currency)?.rateTwd ?? null;
  }
  /** 先讀已存的匯率；沒有該幣別就請 Worker 更新一次再讀，仍沒有就讓使用者手填。 */
  async function selectCurrency(currency: string) {
    fxCurrency = currency;
    fxRateText = "";
    rateMissing = false;
    if (!currency) return;
    rateLoading = true;
    try {
      let rate = await readRate(currency);
      if (rate == null) {
        await api.post("/api/exchange-rates/refresh", {
          currencies: [currency],
        });
        rate = await readRate(currency);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.exchangeRates,
        });
      }
      // 使用者在等待期間已改選其他幣別或自行填了匯率時，不覆寫。
      if (fxCurrency === currency && !fxRateText) {
        if (rate != null && rate > 0)
          fxRateText = String(Number(rate.toPrecision(6)));
        else rateMissing = true;
      }
    } catch {
      if (fxCurrency === currency && !fxRateText) rateMissing = true;
    } finally {
      rateLoading = false;
    }
  }

  const save = createMutation(() => ({
    mutationFn: async (input: ManualActivityInput) => {
      if (initial)
        return api.put(
          `/api/activity/manual/${encodeURIComponent(initial.id)}`,
          input,
        );
      return api.post<{ id: string }>("/api/activity/manual", input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bank });
      onSaved(editing ? "手動記錄已更新" : "已新增手動記錄");
    },
    onError: () => {
      error = "儲存失敗，請再試一次。";
    },
  }));

  function submit() {
    error = "";
    const built = buildManualActivityInput({
      kind,
      categoryId,
      name,
      date,
      twdText,
      fxCurrency,
      fxAmountText,
      fxRateText,
    });
    if (built.error !== undefined) {
      error = built.error;
      return;
    }
    save.mutate(built.input);
  }
</script>

<svelte:window
  onkeydown={(event: KeyboardEvent) => event.key === "Escape" && onClose()}
/>

<div
  aria-modal="true"
  aria-labelledby="manual-activity-title"
  class="fixed inset-0 z-[70] flex items-end bg-inverse/45 md:items-center md:justify-center md:p-6"
  role="dialog"
>
  <button
    aria-label="關閉"
    class="absolute inset-0 cursor-default"
    onclick={onClose}
    tabindex="-1"
    type="button"
  ></button>
  <form
    class="relative flex max-h-[92vh] max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-card shadow-2xl md:max-w-lg md:rounded-2xl"
    onsubmit={(event) => {
      event.preventDefault();
      submit();
    }}
  >
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 md:p-6">
      <div class="flex items-center justify-between gap-3">
        <h2 id="manual-activity-title" class="text-xl font-semibold">
          {editing ? "編輯手動記錄" : "新增手動記錄"}
        </h2>
        <Button
          aria-label="關閉"
          class="rounded-full"
          onclick={onClose}
          size="icon"
          variant="ghost"><X class="size-5" /></Button
        >
      </div>

      <div
        class="mt-4 grid grid-cols-2 rounded-full bg-ink/5 p-1 text-sm font-medium"
        role="group"
        aria-label="收支別"
      >
        <button
          type="button"
          aria-pressed={kind === "expense"}
          class={`min-h-10 rounded-full transition ${kind === "expense" ? "bg-coral text-white shadow-xs" : "text-subtle"}`}
          onclick={() => (kind = "expense")}>支出</button
        >
        <button
          type="button"
          aria-pressed={kind === "income"}
          class={`min-h-10 rounded-full transition ${kind === "income" ? "bg-moss text-white shadow-xs" : "text-subtle"}`}
          onclick={() => (kind = "income")}>收入</button
        >
      </div>

      <div class="mt-4">
        <label class="text-caption text-subtle" for="manual-name">名稱</label>
        <Input
          id="manual-name"
          autocomplete="off"
          bind:value={name}
          class="mt-1 h-11 text-base sm:text-sm"
          maxlength={200}
          placeholder={kind === "expense" ? "例：午餐、捷運" : "例：薪資"}
        />
      </div>

      <div class="mt-4">
        <p class="text-caption text-subtle">分類</p>
        <div class="mt-2 flex max-h-40 flex-wrap gap-2 overflow-y-auto">
          {#each categories as category (category.id)}
            {@const active = categoryId === category.id}
            <button
              type="button"
              aria-pressed={active}
              class={`min-h-9 rounded-full border px-3 py-1.5 text-sm transition ${active ? "border-transparent bg-steel text-white" : "border-ink/10 bg-paper text-ink"}`}
              onclick={() => (categoryId = active ? "" : category.id)}
              >{category.label}</button
            >
          {/each}
        </div>
      </div>

      <div class="mt-4">
        <label class="text-caption text-subtle" for="manual-date">日期</label>
        <Input
          id="manual-date"
          bind:value={date}
          class="mt-1 h-11 w-full text-base sm:text-sm"
          type="date"
        />
      </div>

      <div class="mt-4">
        <label class="text-caption text-subtle" for="manual-twd"
          >金額（台幣）</label
        >
        <Input
          id="manual-twd"
          autocomplete="off"
          class="mt-1 h-12 text-2xl font-semibold tabular-nums"
          inputmode="decimal"
          oninput={() => (twdTouched = true)}
          placeholder="0"
          bind:value={twdText}
        />
      </div>

      <div class="mt-4 grid gap-3 rounded-xl border border-ink/10 bg-paper p-4">
        <div class="flex items-center justify-between gap-3">
          <label class="text-sm font-semibold" for="manual-fx-currency"
            >外幣（選填）</label
          >
          <Select
            id="manual-fx-currency"
            class="h-10 w-32"
            value={fxCurrency}
            onchange={(event: Event) =>
              void selectCurrency(
                (event.currentTarget as HTMLSelectElement).value,
              )}
          >
            <option value="">不使用</option>
            {#each FX_CURRENCIES as currency (currency)}
              <option value={currency}>{currency}</option>
            {/each}
          </Select>
        </div>
        {#if fxCurrency}
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-caption text-subtle" for="manual-fx-amount"
                >原幣金額</label
              >
              <Input
                id="manual-fx-amount"
                autocomplete="off"
                class="mt-1 text-base tabular-nums sm:text-sm"
                inputmode="decimal"
                placeholder="0"
                bind:value={fxAmountText}
              />
            </div>
            <div>
              <label class="text-caption text-subtle" for="manual-fx-rate"
                >匯率（1 {fxCurrency} = ? 台幣）</label
              >
              <Input
                id="manual-fx-rate"
                autocomplete="off"
                class="mt-1 text-base tabular-nums sm:text-sm"
                inputmode="decimal"
                oninput={() => (rateMissing = false)}
                placeholder={rateLoading ? "查詢中…" : "0"}
                bind:value={fxRateText}
              />
            </div>
          </div>
          {#if rateMissing}<p class="text-caption text-coral">
              查不到 {fxCurrency} 匯率，請自行填入。
            </p>{/if}
          <p class="text-caption text-subtle">
            台幣金額會依「原幣金額 × 匯率」自動帶入，也可以直接修改上方金額。
          </p>
        {/if}
      </div>

      {#if error}
        <p class="mt-3 text-sm text-coral" role="alert">{error}</p>
      {/if}
    </div>

    <div
      class="shrink-0 border-t border-ink/10 bg-card px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:px-6 md:pb-6"
    >
      <div class="grid grid-cols-[1fr_2fr] gap-3">
        <Button class="h-11" variant="secondary" onclick={onClose}>取消</Button>
        <Button
          class={`h-11 text-white ${kind === "expense" ? "bg-coral hover:bg-coral/90" : "bg-moss hover:bg-moss/90"}`}
          disabled={save.isPending}
          type="submit"
          >{save.isPending
            ? "儲存中…"
            : editing
              ? "儲存修改"
              : "記一筆"}</Button
        >
      </div>
    </div>
  </form>
</div>
