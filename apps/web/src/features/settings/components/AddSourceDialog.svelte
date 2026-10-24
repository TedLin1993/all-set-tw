<script lang="ts">
  import { Dialog } from "bits-ui";
  import { Search, X } from "@lucide/svelte";
  import type { ConnectorId } from "@/data/connectors/types";
  import {
    isBankSource,
    sourceCapabilitySummary,
    sourceIcon,
    type ConnectorSource,
  } from "../model/sources";
  let {
    open = $bindable(false),
    sources,
    connectedCount,
    onSelect,
    onSelectedClose,
  }: {
    open?: boolean;
    sources: readonly ConnectorSource[];
    connectedCount: number;
    onSelect: (id: ConnectorId) => void;
    /** 選取來源後關閉時呼叫，由頁面把焦點移到新顯示的詳情；一般取消仍還原到原觸發按鈕。 */
    onSelectedClose: () => void;
  } = $props();
  let query = $state("");
  let searchInput = $state<HTMLInputElement>();
  let selected = false;
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
</script>

<!-- bits-ui Dialog 負責焦點限制、關閉後還原焦點、Esc／點擊背景關閉與背景捲動鎖定。 -->
<Dialog.Root
  bind:open
  onOpenChangeComplete={(isOpen) => {
    if (!isOpen) query = "";
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[70] bg-ink/45" />
    <Dialog.Content
      class="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-paper shadow-2xl outline-none md:inset-auto md:left-1/2 md:top-[8vh] md:max-h-[84vh] md:w-[calc(100%-3rem)] md:max-w-2xl md:-translate-x-1/2 md:rounded-2xl md:bg-card"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        searchInput?.focus();
      }}
      onCloseAutoFocus={(event) => {
        if (!selected) return;
        selected = false;
        event.preventDefault();
        onSelectedClose();
      }}
    >
      <div
        class="flex items-start justify-between gap-3 px-4 pb-3 pt-[max(env(safe-area-inset-top),1rem)] md:px-6 md:pt-5"
      >
        <div>
          <Dialog.Title level={2} class="text-xl font-semibold">
            新增資料來源
          </Dialog.Title>
          <Dialog.Description class="mt-1 text-sm text-muted-foreground">
            選擇要連接的機構，接著輸入登入資訊。
          </Dialog.Description>
        </div>
        <Dialog.Close
          aria-label="關閉"
          class="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
          ><X class="size-5" /></Dialog.Close
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
                  onclick={() => {
                    selected = true;
                    onSelect(source.id);
                  }}
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
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
