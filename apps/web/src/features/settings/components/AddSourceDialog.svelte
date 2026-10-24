<script lang="ts">
  import { onMount } from "svelte";
  import { Search, X } from "@lucide/svelte";
  import type { ConnectorId } from "@/data/connectors/types";
  import {
    isBankSource,
    sourceCapabilitySummary,
    sourceIcon,
    type ConnectorSource,
  } from "../model/sources";
  let {
    sources,
    connectedCount,
    onSelect,
    onClose,
  }: {
    sources: readonly ConnectorSource[];
    connectedCount: number;
    onSelect: (id: ConnectorId) => void;
    onClose: () => void;
  } = $props();
  let query = $state("");
  let searchInput = $state<HTMLInputElement>();
  const filtered = $derived.by(() => {
    const term = query.trim().toLowerCase();
    if (!term) return sources;
    return sources.filter(
      (source) =>
        source.title.toLowerCase().includes(term) ||
        sourceCapabilitySummary(source).includes(term),
    );
  });
  const groups = $derived(
    [
      {
        label: "發票與投資",
        items: filtered.filter((source) => !isBankSource(source)),
      },
      { label: "銀行", items: filtered.filter(isBankSource) },
    ].filter((group) => group.items.length),
  );

  onMount(() => searchInput?.focus());
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") onClose();
  }}
/>

<div
  class="fixed inset-0 z-[70] flex bg-ink/45 md:items-start md:justify-center md:p-6 md:pt-[8vh]"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <div
    aria-labelledby="add-source-title"
    aria-modal="true"
    class="flex h-full w-full flex-col overflow-hidden bg-paper shadow-2xl md:h-auto md:max-h-[84vh] md:max-w-2xl md:rounded-2xl md:bg-card"
    role="dialog"
  >
    <div
      class="flex items-start justify-between gap-3 px-4 pb-3 pt-[max(env(safe-area-inset-top),1rem)] md:px-6 md:pt-5"
    >
      <div>
        <h2 id="add-source-title" class="text-xl font-semibold">
          新增資料來源
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          選擇要連接的機構，接著輸入登入資訊。
        </p>
      </div>
      <button
        type="button"
        aria-label="關閉"
        class="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
        onclick={onClose}><X class="size-5" /></button
      >
    </div>
    <div class="px-4 md:px-6">
      <label class="relative block">
        <span class="sr-only">搜尋機構</span>
        <Search
          aria-hidden="true"
          class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          bind:this={searchInput}
          bind:value={query}
          class="h-11 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-base outline-none focus:border-steel focus:ring-2 focus:ring-steel/15 md:text-sm"
          placeholder="搜尋銀行或服務名稱"
          type="search"
        />
      </label>
    </div>
    <div
      class="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-1 md:px-6 md:pb-6"
    >
      {#each groups as group (group.label)}
        <section class="mt-4" aria-label={group.label}>
          <h3 class="mb-2 text-sm font-semibold text-muted-foreground">
            {group.label} · {group.items.length}
          </h3>
          <div class="grid gap-2 sm:grid-cols-2">
            {#each group.items as source (source.id)}
              {@const SourceIcon = sourceIcon(source.id)}
              <button
                type="button"
                class="flex min-h-14 min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition hover:border-steel/50 hover:bg-steel/5 focus-visible:outline-2 focus-visible:outline-steel md:bg-muted/40"
                aria-label={`連接${source.title}`}
                onclick={() => onSelect(source.id)}
              >
                <span
                  class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-steel/10 text-steel"
                  ><SourceIcon class="size-[18px]" /></span
                >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-semibold"
                    >{source.title}</span
                  >
                  <span
                    class="mt-0.5 block truncate text-xs text-muted-foreground"
                    >{sourceCapabilitySummary(source)}</span
                  >
                </span>
              </button>
            {/each}
          </div>
        </section>
      {:else}
        <p class="py-10 text-center text-sm text-muted-foreground">
          {sources.length ? "找不到符合的機構。" : "所有資料來源都已連接。"}
        </p>
      {/each}
      {#if connectedCount}
        <p class="mt-5 text-xs text-muted-foreground">
          已連接的 {connectedCount} 個來源不在此列出，請在資料來源清單中管理。
        </p>
      {/if}
    </div>
  </div>
</div>
