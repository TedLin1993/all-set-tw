<script lang="ts">
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import Card from "@/shared/ui/Card.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Switch from "@/shared/ui/Switch.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { messageFromError } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import { formatDateTime, formatNumber } from "@/shared/format/financial";
  import { aiClassificationQuery } from "@/data/classification/queries";
  import type { AiClassificationStatus } from "@/data/classification/types";

  let { api, demoMode = false }: { api: ApiClient; demoMode?: boolean } =
    $props();

  const status = createQuery(aiClassificationQuery(() => api));
  const qc = useQueryClient();
  let confirming = $state<"enable" | "backfill" | "clear" | null>(null);
  let error = $state("");

  const data = $derived($status.data);
  const enabled = $derived(data?.enabled ?? false);
  const hasResults = $derived(
    (data?.classifiedCount ?? 0) + (data?.undeterminedCount ?? 0) > 0,
  );

  function applyStatus(next: AiClassificationStatus) {
    qc.setQueryData(queryKeys.aiClassification, next);
    error = "";
  }

  // New AI categories show up in activity once a scan settles.
  let wasScanning = false;
  $effect(() => {
    const scanning = data?.scanning ?? false;
    if (wasScanning && !scanning)
      qc.invalidateQueries({ queryKey: queryKeys.bank });
    wasScanning = scanning;
  });

  const setEnabled = createMutation({
    mutationFn: (next: boolean) =>
      api.put<AiClassificationStatus>("/api/classification/ai", {
        enabled: next,
      }),
    onSuccess: applyStatus,
    onError: (cause) => (error = messageFromError(cause)),
  });
  const backfill = createMutation({
    mutationFn: () =>
      api.post<AiClassificationStatus>("/api/classification/ai/backfill", {}),
    onSuccess: applyStatus,
    onError: (cause) => (error = messageFromError(cause)),
  });
  const clear = createMutation({
    mutationFn: () =>
      api.delete<AiClassificationStatus>("/api/classification/ai/results"),
    onSuccess: (next) => {
      applyStatus(next);
      qc.invalidateQueries({ queryKey: queryKeys.bank });
    },
    onError: (cause) => (error = messageFromError(cause)),
  });
  const busy = $derived(
    $setEnabled.isPending || $backfill.isPending || $clear.isPending,
  );

  // Turning it on explains what is sent and what it costs first; turning it
  // off keeps the results already applied, so it needs no confirmation.
  function requestEnabled(next: boolean) {
    if (next) confirming = "enable";
    else $setEnabled.mutate(false);
  }

  function confirm() {
    const action = confirming;
    confirming = null;
    if (action === "enable") $setEnabled.mutate(true);
    if (action === "backfill") $backfill.mutate();
    if (action === "clear") $clear.mutate();
  }

  // One set of numbers: every stored AI result, whichever scan produced it.
  const totals = $derived(
    data
      ? `目前由 AI 分類 ${formatNumber(data.classifiedCount)} 筆、無法判斷 ${formatNumber(data.undeterminedCount)} 筆`
      : "",
  );
  const backfillSummary = $derived.by(() => {
    const backfillState = data?.backfill;
    if (!backfillState || backfillState.status === "idle")
      return hasResults
        ? totals
        : "啟用前已同步的未分類活動不會自動處理，按下按鈕後才交由 AI 分類。";
    return backfillState.status === "running"
      ? `處理中，${totals}`
      : `${formatDateTime(backfillState.completedAt ?? undefined)} 完成，${totals}`;
  });
</script>

<Card class="w-full min-w-0">
  <CardHeader class="gap-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h2 class="text-lg font-semibold">AI 自動分類</h2>
        <p class="text-sm text-muted-foreground">
          規則無法判斷的活動，同步後由 AI
          依各分類的定義自動分類；判斷不出來的維持未分類。
        </p>
      </div>
      <Switch
        aria-label={enabled ? "停用 AI 自動分類" : "啟用 AI 自動分類"}
        disabled={demoMode || busy || !data}
        bind:checked={() => enabled, requestEnabled}
      />
    </div>
  </CardHeader>
  <CardContent class="grid gap-4">
    {#if $status.isPending}
      <p class="text-sm text-muted-foreground">載入中…</p>
    {:else if $status.isError}
      <p class="text-sm text-coral">AI 自動分類狀態載入失敗。</p>
    {:else if data}
      {#if enabled}
        <div class="rounded-lg border border-border bg-muted/30 p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="text-sm font-semibold">過往紀錄</h3>
              <p class="mt-1 text-sm text-muted-foreground">
                {backfillSummary}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={demoMode || busy || data.backfill.status === "running"}
              onclick={() => (confirming = "backfill")}
              >{data.backfill.status === "running"
                ? "處理中…"
                : "自動分類過往紀錄"}</Button
            >
          </div>
          {#if data.pausedUntil}
            <p class="mt-3 text-sm text-amber-800">
              今日 AI 額度已用完，{formatDateTime(data.pausedUntil)} 後自動繼續。
            </p>
          {/if}
        </div>
      {/if}
      {#if !enabled && hasResults}
        <p class="text-sm text-muted-foreground">
          已停用：不再分類新的活動，已分類的結果仍會保留。{totals}。
        </p>
      {/if}
      {#if hasResults}
        <div class="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={demoMode || busy}
            onclick={() => (confirming = "clear")}>清除 AI 分類結果</Button
          >
        </div>
      {/if}
    {/if}
    {#if error}<p class="text-sm text-coral">{error}</p>{/if}
  </CardContent>
</Card>

{#if confirming}
  <div
    aria-modal="true"
    aria-labelledby="ai-classification-confirm-title"
    class="fixed inset-0 z-[70] flex items-end bg-ink/45 md:items-center md:justify-center md:p-6"
    role="dialog"
  >
    <div
      class="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl md:max-w-lg md:rounded-2xl md:p-6"
    >
      <h2 id="ai-classification-confirm-title" class="text-xl font-semibold">
        {confirming === "enable"
          ? "啟用 AI 自動分類"
          : confirming === "backfill"
            ? "自動分類過往紀錄"
            : "清除 AI 分類結果"}
      </h2>
      <ul
        class="mt-4 grid list-disc gap-2 pl-5 text-sm leading-relaxed text-subtle"
      >
        {#if confirming === "enable"}
          <li>
            啟用後同步進來的活動，若規則、手動分類、轉帳與退費配對都無法判斷，會由
            Cloudflare Workers AI 依各分類的定義判斷；判斷不出來的維持未分類。
          </li>
          <li>啟用前的紀錄不會自動處理；需要時可按「自動分類過往紀錄」。</li>
          <li>
            會送出交易摘要、金額與配對到的電子發票品項，在你自己的 Cloudflare
            帳號內處理。
          </li>
          <li>
            使用 Workers AI 每日免費額度，與驗證碼辨識共用。每天最多分類 2,000
            筆，約佔一半額度；超過時隔天自動繼續。
          </li>
          <li>手動分類與規則永遠優先；AI 分類的活動可以直接改分類。</li>
        {:else if confirming === "backfill"}
          <li>只處理目前未分類的活動，不會改動手動分類與規則分類。</li>
          <li>
            在背景由新到舊逐月處理，可以離開此頁；完成後活動頁會顯示新分類。
          </li>
          <li>每天最多分類 2,000 筆；超過時隔天自動繼續。</li>
        {:else}
          <li>
            由 AI 分類的 {formatNumber(data?.classifiedCount ?? 0)}
            筆活動會回到未分類；手動分類與規則不受影響。
          </li>
          <li>之後可以重新執行「自動分類過往紀錄」。</li>
        {/if}
      </ul>
      <div class="mt-5 grid grid-cols-2 gap-3">
        <Button variant="secondary" onclick={() => (confirming = null)}
          >取消</Button
        >
        <Button
          variant={confirming === "clear" ? "destructive" : "default"}
          onclick={confirm}
          >{confirming === "enable"
            ? "啟用"
            : confirming === "backfill"
              ? "開始分類"
              : "清除"}</Button
        >
      </div>
    </div>
  </div>
{/if}
