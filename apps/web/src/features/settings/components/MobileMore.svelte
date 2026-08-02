<script lang="ts">
  import { Clock3, Database, Settings, WalletCards } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import type { View } from "@/app/types";
  import type { BankData } from "@/data/bank/types";
  import type { ClassificationRuleRow } from "@/data/classification/types";
  import { connectorDefinitions } from "@/data/connectors/definitions";
  import {
    getActionableSyncJobs,
    getSyncSourceStatus,
  } from "@/data/connectors/sync-status";
  import type { ConnectorId, SyncJobRow } from "@/data/connectors/types";
  let {
    demoMode,
    jobs,
    rules,
    bank,
    navigate,
    openConnector,
  }: {
    api: ApiClient;
    demoMode: boolean;
    jobs: SyncJobRow[];
    rules: ClassificationRuleRow[];
    bank: BankData;
    navigate: (view: View) => void;
    openConnector: (id: ConnectorId) => void;
  } = $props();
  const sources = connectorDefinitions;
  const configuredSources = $derived(
    jobs.filter((job) => job.configured && job.scope === "all"),
  );
  const unhealthy = $derived(getActionableSyncJobs(jobs));
</script>

<div class="grid gap-4">
  {#if demoMode}<span
      class="w-fit rounded-full bg-steel/10 px-3 py-1 text-sm font-semibold text-steel"
      >Demo 資料</span
    >{/if}
  <Card
    ><CardContent class="pt-5"
      ><p class="text-sm font-semibold text-ink/45">資料健康度</p>
      <p class="mt-2 text-2xl font-bold">
        {Math.max(configuredSources.length - unhealthy.length, 0)} / {configuredSources.length}
        已設定來源正常
      </p>
      {#if unhealthy.length}<p class="mt-2 text-sm font-semibold text-coral">
          {unhealthy.length} 個來源需要處理
        </p>{/if}</CardContent
    ></Card
  >
  <section>
    <h2 class="mb-2 text-base font-semibold text-ink/50">設定與資料</h2>
    <Card
      ><div class="divide-y divide-ink/8">
        <button
          class="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left"
          onclick={() => navigate("data-sources")}
          ><span
            class="flex size-10 items-center justify-center rounded-xl bg-steel/10 text-steel"
            ><Database class="size-5" /></span
          ><span class="flex-1"
            ><span class="block font-semibold">資料來源與連接器</span><span
              class="block text-sm text-ink/45">狀態、憑證、排程與重新驗證</span
            ></span
          ><span class="text-sm font-semibold text-steel"
            >{sources.length} 個　›</span
          ></button
        >
        <button
          class="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left"
          onclick={() => navigate("sync-notifications")}
          ><span
            class="flex size-10 items-center justify-center rounded-xl bg-steel/10 text-steel"
            ><Clock3 class="size-5" /></span
          ><span class="flex-1"
            ><span class="block font-semibold">同步與通知</span><span
              class="block text-sm text-ink/45">預設排程、推播與同步結果</span
            ></span
          ><span class="text-sm font-semibold text-steel">›</span></button
        >
        <button
          class="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left"
          onclick={() => navigate("exchange-rates")}
          ><span
            class="flex size-10 items-center justify-center rounded-xl bg-steel/10 text-steel"
            ><WalletCards class="size-5" /></span
          ><span class="flex-1"
            ><span class="block font-semibold">匯率</span><span
              class="block text-sm text-ink/45">查看外幣換算</span
            ></span
          ><span class="text-sm font-semibold text-steel">›</span></button
        >
        <button
          class="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left"
          onclick={() => navigate("classification-rules")}
          ><span
            class="flex size-10 items-center justify-center rounded-xl bg-steel/10 text-steel"
            ><Settings class="size-5" /></span
          ><span class="flex-1"
            ><span class="block font-semibold">分類規則</span><span
              class="block text-sm text-ink/45">銀行交易自動分類</span
            ></span
          ><span class="text-sm font-semibold text-steel"
            >{rules.length} 條　›</span
          ></button
        >
      </div></Card
    >
  </section>
  <section>
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-base font-semibold text-ink/50">資料來源</h2>
      <button
        class="min-h-8 px-2 text-sm font-semibold text-steel"
        onclick={() => navigate("data-sources")}>管理</button
      >
    </div>
    <Card
      ><div class="divide-y divide-ink/8">
        {#each sources as source (source.id)}{@const job = jobs.find(
            (item) => item.connectorId === source.id,
          )}
          <button
            type="button"
            class="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition hover:bg-paper focus-visible:outline-2 focus-visible:outline-steel"
            aria-label={`管理${source.title}`}
            onclick={() => openConnector(source.id)}
          >
            <span class="font-semibold">{source.title}</span><span
              class={getSyncSourceStatus(job) === "needs_action"
                ? "text-coral"
                : "text-moss"}
              >{getSyncSourceStatus(job) === "needs_action"
                ? "需要處理"
                : getSyncSourceStatus(job) === "healthy"
                  ? "正常"
                  : getSyncSourceStatus(job) === "not_synced"
                    ? "尚未同步"
                    : "未設定"}</span
            >
          </button>{/each}
      </div></Card
    >
  </section>
</div>
