<script lang="ts">
  import { Dialog } from "bits-ui";
  import { Search, X } from "@lucide/svelte";
  import { MediaQuery } from "svelte/reactivity";
  import type { ConnectorId } from "@/data/connectors/types";
  import { swipeBack } from "@/shared/actions/swipe-back";
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
    preview = false,
  }: {
    open?: boolean;
    sources: readonly ConnectorSource[];
    connectedCount: number;
    onSelect: (id: ConnectorId) => void;
    /** 選取來源後關閉時呼叫，由頁面把焦點移到新顯示的詳情；一般取消仍還原到原觸發按鈕。 */
    onSelectedClose: () => void;
    /** 只渲染靜態面板（不含 Dialog），供手機跟手返回時當作底層頁面。 */
    preview?: boolean;
  } = $props();
  let query = $state("");
  let searchInput = $state<HTMLInputElement>();
  let selected = false;
  // 手機版是全螢幕子頁：左上返回鍵；PWA 中可從左緣跟手右滑返回，底下露出原頁面。
  const SWIPE_SETTLE_MS = 200;
  const mobileLayout = new MediaQuery("(max-width: 767.98px)");
  let swipeOffset = $state(0);
  let swiping = $state(false);
  let swipeTimer: ReturnType<typeof setTimeout> | undefined;
  const swipeProgress = $derived(Math.min(1, swipeOffset / window.innerWidth));
  function dragClose(distance: number) {
    clearTimeout(swipeTimer);
    swiping = true;
    swipeOffset = distance;
  }
  function cancelSwipe() {
    swiping = false;
    swipeOffset = 0;
  }
  function commitSwipe() {
    swiping = false;
    swipeOffset = window.innerWidth;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    swipeTimer = setTimeout(
      () => (open = false),
      reduceMotion ? 0 : SWIPE_SETTLE_MS,
    );
  }
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

{#snippet sourcePicker()}
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
{/snippet}

{#if preview}
  <!-- 手機跟手返回時當作底層頁面的靜態畫面，外觀與手機版面板一致。 -->
  <div class="flex h-full flex-col overflow-hidden bg-paper">
    <div class="px-4 pb-3 pt-[max(env(safe-area-inset-top),1rem)]">
      <div class="flex items-center gap-2">
        <span
          class="flex size-10 shrink-0 items-center justify-center rounded-full text-xl text-ink"
          >←</span
        >
        <h2
          class="min-w-0 flex-1 truncate text-2xl font-semibold tracking-tight"
        >
          新增資料來源
        </h2>
      </div>
      <p class="mt-1 text-sm text-muted-foreground">
        選擇要連接的機構，接著輸入登入資訊。
      </p>
    </div>
    {@render sourcePicker()}
  </div>
{:else}
  <!-- bits-ui Dialog 負責焦點限制、關閉後還原焦點、Esc／點擊背景關閉與背景捲動鎖定。 -->
  <Dialog.Root
    bind:open
    onOpenChangeComplete={(isOpen) => {
      if (isOpen) return;
      query = "";
      clearTimeout(swipeTimer);
      cancelSwipe();
    }}
  >
    <Dialog.Portal>
      <Dialog.Overlay>
        {#snippet child({ props })}
          <div
            {...props}
            class={`fixed inset-0 z-[70] bg-inverse/45 ${swiping ? "" : "transition-opacity duration-200 ease-out motion-reduce:transition-none"}`}
            style:opacity={swipeOffset > 0 ? 1 - swipeProgress : undefined}
          ></div>
        {/snippet}
      </Dialog.Overlay>
      <Dialog.Content
        onOpenAutoFocus={(event) => {
          // 手機版不自動聚焦搜尋框，避免一打開就跳出鍵盤擋住清單；交由預設行為聚焦返回鍵。
          if (mobileLayout.current) return;
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
        {#snippet child({ props })}
          <div
            {...props}
            class={`fixed inset-0 z-[70] flex flex-col overflow-hidden bg-paper shadow-2xl outline-none md:inset-auto md:left-1/2 md:top-[8vh] md:max-h-[84vh] md:w-[calc(100%-3rem)] md:max-w-2xl md:-translate-x-1/2 md:rounded-2xl md:bg-card ${swiping ? "" : "transition-transform duration-200 ease-out motion-reduce:transition-none"}`}
            style:transform={swipeOffset > 0
              ? `translateX(${swipeOffset}px)`
              : undefined}
            use:swipeBack={{
              enabled:
                mobileLayout.current &&
                document.documentElement.classList.contains("is-standalone"),
              onBack: commitSwipe,
              onDrag: dragClose,
              onCancel: cancelSwipe,
            }}
          >
            <div
              class="px-4 pb-3 pt-[max(env(safe-area-inset-top),1rem)] md:px-6 md:pt-5"
            >
              <div class="flex items-center gap-2">
                <Dialog.Close
                  aria-label="返回"
                  class="flex size-10 shrink-0 items-center justify-center rounded-full text-xl text-ink hover:bg-ink/5 md:hidden"
                  >←</Dialog.Close
                >
                <Dialog.Title
                  level={2}
                  class="min-w-0 flex-1 truncate text-2xl font-semibold tracking-tight md:text-xl md:tracking-normal"
                >
                  新增資料來源
                </Dialog.Title>
                <Dialog.Close
                  aria-label="關閉"
                  class="hidden size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted md:flex"
                  ><X class="size-5" /></Dialog.Close
                >
              </div>
              <Dialog.Description class="mt-1 text-sm text-muted-foreground">
                選擇要連接的機構，接著輸入登入資訊。
              </Dialog.Description>
            </div>
            {@render sourcePicker()}
          </div>
        {/snippet}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{/if}
