<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChartCandlestick, Landmark, ReceiptText } from "@lucide/svelte";
  import { toStore } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import Button from "@/shared/ui/Button.svelte";
  import Badge from "@/shared/ui/Badge.svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { connectorSettingsQuery } from "@/data/connectors/queries";
  import type { ConnectorId, SyncJobRow } from "@/data/connectors/types";
  import { getSyncSourceStatus } from "@/data/connectors/sync-status";
  import { formatDateTime } from "@/shared/format/financial";
  let {
    api,
    id,
    title,
    description,
    selected,
    onConfigure,
    jobs,
    compact = false,
    compactCard = false,
    children,
  }: {
    api: ApiClient;
    id: ConnectorId;
    title: string;
    description: string;
    selected: boolean;
    onConfigure: () => void;
    jobs?: SyncJobRow[];
    compact?: boolean;
    compactCard?: boolean;
    children?: Snippet;
  } = $props();
  const settings = createQuery(
    toStore(() => connectorSettingsQuery(() => api, id)),
  );
  const job = $derived(
    (jobs ?? []).find(
      (item) => item.connectorId === id && item.scope === "all",
    ),
  );
  const sourceStatus = $derived(
    getSyncSourceStatus(job, $settings.data?.configured ?? job?.configured),
  );
  const needsAction = $derived(sourceStatus === "needs_action");
  const weekdays = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
  const scheduleLabel = $derived(
    !job?.enabled
      ? "關閉"
      : job.scheduleMode === "inherit"
        ? "跟隨預設"
        : job.intervalMinutes === 1440
          ? `每天 ${job.preferredTime}`
          : job.intervalMinutes === 10080
            ? `每${weekdays[job.preferredWeekday] ?? "週一"} ${job.preferredTime}`
            : `每 ${job.intervalMinutes / 60} 小時`,
  );
  const SourceIcon = $derived(
    id === "einvoice"
      ? ReceiptText
      : id === "tdcc"
        ? ChartCandlestick
        : Landmark,
  );
</script>

{#if compact}
  <button
    type="button"
    class={`group flex w-full items-center text-left transition ${compactCard ? "min-h-20 gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-sm" : "min-h-12 gap-3 border-t border-border py-2.5 hover:bg-muted/40"} ${selected && compactCard ? "border-steel/50 ring-2 ring-steel/15" : ""}`}
    aria-label={`管理${title}`}
    onclick={onConfigure}
  >
    <span
      class={`flex shrink-0 items-center justify-center rounded-lg bg-steel/10 text-steel ${compactCard ? "size-10" : "size-8"}`}
    >
      <SourceIcon class={compactCard ? "size-5" : "size-4.5"} />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-semibold text-foreground"
        >{title}</span
      >
      <span class="block truncate text-sm text-muted-foreground">
        {sourceStatus === "unconfigured"
          ? "尚未設定"
          : job?.lastSuccessAt
            ? `${sourceStatus === "healthy" ? "最近同步" : "上次成功"} ${formatDateTime(job.lastSuccessAt)}`
            : "尚未成功同步"}
      </span>
    </span>
    <Badge
      class="shrink-0 whitespace-nowrap text-sm"
      variant={needsAction
        ? "destructive"
        : sourceStatus === "healthy"
          ? "success"
          : "secondary"}
      >{needsAction
        ? "需要處理"
        : sourceStatus === "healthy"
          ? "正常"
          : sourceStatus === "not_synced"
            ? "尚未同步"
            : "未設定"}</Badge
    >
    {#if compactCard}<span
        aria-hidden="true"
        class="text-xl leading-none text-muted-foreground">›</span
      >{/if}
  </button>
{:else}
  <Card
    class={`transition duration-200 ${selected ? "sm:col-span-2 lg:col-span-3 2xl:col-span-5 border-steel/50 shadow-md ring-2 ring-steel/15" : "hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-sm"}`}
    ><CardContent class="pt-5"
      ><div class="flex items-start justify-between gap-4">
        <div class="flex min-w-0 items-start gap-3">
          <span
            class={`flex size-10 shrink-0 items-center justify-center rounded-xl ${selected ? "bg-steel text-white" : "bg-steel/10 text-steel"}`}
          >
            <SourceIcon class="size-5" />
          </span>
          <div class="min-w-0">
            <h2 class="font-semibold">{title}</h2>
            <p class="mt-0.5 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <Badge
          class="shrink-0 whitespace-nowrap text-sm"
          variant={needsAction
            ? "destructive"
            : sourceStatus !== "unconfigured"
              ? "success"
              : "secondary"}
          >{needsAction
            ? "需要處理"
            : sourceStatus !== "unconfigured"
              ? "已設定"
              : "未設定"}</Badge
        >
      </div>
      <div
        class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"
      >
        <div class="text-sm text-muted-foreground">
          <p>
            上次成功：{job?.lastSuccessAt
              ? formatDateTime(job.lastSuccessAt)
              : "尚無紀錄"}
          </p>
          <p class="mt-1">
            排程：{scheduleLabel}
          </p>
        </div>
        <Button
          size="sm"
          variant={selected ? "default" : "outline"}
          aria-expanded={selected}
          onclick={onConfigure}>{selected ? "收合" : "管理設定"}</Button
        >
      </div>
      {#if selected && children}
        <div class="mt-5 border-t border-border pt-5">
          {@render children()}
        </div>
      {/if}</CardContent
    ></Card
  >
{/if}
