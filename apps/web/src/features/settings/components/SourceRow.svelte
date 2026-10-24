<script lang="ts">
  import Badge from "@/shared/ui/Badge.svelte";
  import type { ConnectorId, SyncJobRow } from "@/data/connectors/types";
  import {
    getSyncSourceStatus,
    getSyncSourceStatusLabel,
  } from "@/data/connectors/sync-status";
  import { formatSyncSchedule } from "../model/schedule";
  import { sourceIcon } from "../model/sources";
  let {
    id,
    title,
    job,
    selected = false,
    onSelect,
  }: {
    id: ConnectorId;
    title: string;
    job: SyncJobRow | undefined;
    selected?: boolean;
    onSelect: () => void;
  } = $props();
  const sourceStatus = $derived(getSyncSourceStatus(job));
  const needsAction = $derived(sourceStatus === "needs_action");
  const scheduleLabel = $derived(
    !job?.enabled
      ? "自動同步關閉"
      : job.scheduleMode === "inherit"
        ? "跟隨預設排程"
        : formatSyncSchedule(job),
  );
  const SourceIcon = $derived(sourceIcon(id));
  // 清單列空間有限，只顯示月日與時間；完整時間在詳情面板。
  const shortDateTime = new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const statusText = $derived(
    sourceStatus === "unconfigured"
      ? "尚未設定"
      : job?.lastSuccessAt
        ? `${sourceStatus === "healthy" ? "最近同步" : "上次成功"} ${shortDateTime.format(new Date(job.lastSuccessAt))}`
        : "尚未成功同步",
  );
</script>

<button
  type="button"
  class={`flex min-h-14 w-full items-center gap-3 border-t border-border px-4 py-2.5 text-left transition hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-steel ${selected ? "bg-steel/8 shadow-[inset_3px_0_0_var(--color-steel)]" : ""}`}
  aria-label={`管理${title}`}
  aria-current={selected ? "true" : undefined}
  onclick={onSelect}
>
  <span
    class={`flex size-9 shrink-0 items-center justify-center rounded-lg ${needsAction ? "bg-coral/10 text-coral" : "bg-steel/10 text-steel"}`}
  >
    <SourceIcon class="size-[18px]" />
  </span>
  <span class="min-w-0 flex-1">
    <span class="block truncate text-sm font-semibold text-foreground"
      >{title}</span
    >
    <span class="block truncate text-sm text-muted-foreground">
      {statusText}<span class="hidden sm:inline">{` · ${scheduleLabel}`}</span>
    </span>
  </span>
  <Badge
    class="shrink-0 whitespace-nowrap text-sm"
    variant={needsAction
      ? "destructive"
      : sourceStatus === "healthy"
        ? "success"
        : "secondary"}>{getSyncSourceStatusLabel(sourceStatus)}</Badge
  >
  <span aria-hidden="true" class="text-xl leading-none text-muted-foreground"
    >›</span
  >
</button>
