<script lang="ts">
  // 手機版分類快篩卡：點分類圖表的圓餅或圖例時（< 768px），取代直接套用列表篩選，
  // 就地開一張底部卡片顯示這個月該分類的總額／近 6 個月／活動清單，
  // 不必捲到很下面的列表就能看內容；「在列表中篩選」才套用原本的篩選行為。
  import { X } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import { flowAmountSign, formatCurrency } from "@/shared/format/financial";
  import { formatActivityDate } from "../model/list";
  import {
    activityCategoryItemsForMonth,
    activityCategorySixMonthSeries,
  } from "../model/category-sheet";
  import type { ActivityCategorySlice, ActivityFlow } from "../model/chart";
  import type { ActivityItem } from "../model/types";

  let {
    flow,
    category,
    slice,
    selectedMonth,
    monthLabel,
    monthKeys,
    items,
    rates,
    sourceLabel,
    onClose,
    onFilter,
    onOpenDetail,
  }: {
    flow: ActivityFlow;
    /** 卡片對應的分類名稱；標題、清單與 6 個月長條都依此計算。 */
    category: string;
    /**
     * 這個分類、這個月份的圓餅切片。卡片開著時若把該分類唯一一筆改成其他分類或排除計算，
     * 切片會消失；此時總額改用清單加總、佔比顯示 0，卡片其餘內容不受影響。
     */
    slice: ActivityCategorySlice | undefined;
    selectedMonth: string;
    monthLabel: string;
    /** 已載入的近 6 個月月份鍵，由舊到新 */
    monthKeys: string[];
    items: ActivityItem[];
    rates: Record<string, number>;
    sourceLabel: (item: ActivityItem) => string;
    onClose: () => void;
    onFilter: () => void;
    onOpenDetail: (item: ActivityItem) => void;
  } = $props();

  const rows = $derived(
    activityCategoryItemsForMonth(items, flow, category, selectedMonth, rates),
  );
  const series = $derived(
    activityCategorySixMonthSeries(items, flow, category, monthKeys, rates),
  );
  const total = $derived(
    slice?.amount ?? rows.reduce((sum, row) => sum + row.amount, 0),
  );
  const maxSeries = $derived(
    Math.max(...series.map((point) => point.amount), 1),
  );

  // 底層頁面（一般瀏覽器捲 body，PWA standalone 捲 #root）都要暫停捲動，
  // 關閉時完整還原成開啟前的樣式，頁面捲動位置不受影響。
  $effect(() => {
    const root = document.getElementById("root");
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = root?.style.overflow ?? "";
    document.body.style.overflow = "hidden";
    if (root) root.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (root) root.style.overflow = previousRootOverflow;
    };
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="fixed inset-0 z-[55] bg-inverse/40"
  role="presentation"
  data-testid="category-detail-sheet"
>
  <button
    type="button"
    aria-label="關閉分類詳情"
    class="absolute inset-0"
    onclick={onClose}
  ></button>
  <div
    aria-labelledby="category-sheet-title"
    aria-modal="true"
    role="dialog"
    class="absolute inset-x-0 bottom-0 flex max-h-[75vh] w-full flex-col rounded-t-2xl bg-card shadow-2xl"
  >
    <header
      class="flex shrink-0 items-start justify-between gap-3 border-b border-ink/10 px-5 pb-4 pt-5"
    >
      <div class="flex min-w-0 items-center gap-2.5">
        <span
          class="mt-0.5 size-3 shrink-0 rounded-full"
          style={`background-color:${slice?.color ?? "#68747b"}`}
        ></span>
        <div class="min-w-0">
          <h2
            id="category-sheet-title"
            class="truncate text-base font-semibold"
          >
            {category}
          </h2>
          <p class="mt-0.5 text-caption text-subtle">
            {monthLabel} · {flow === "income" ? "收入" : "支出"}
          </p>
        </div>
      </div>
      <button
        type="button"
        aria-label="關閉分類詳情"
        class="flex size-9 shrink-0 items-center justify-center rounded-full text-subtle hover:bg-paper"
        onclick={onClose}
      >
        <X class="size-5" />
      </button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div class="flex items-baseline justify-between gap-3">
        <p
          class={`text-xl font-semibold tabular-nums ${flow === "income" ? "text-moss" : "text-coral"}`}
        >
          {flowAmountSign(flow, total)}{formatCurrency(Math.abs(total))}
        </p>
        <p class="text-caption text-subtle">
          佔{flow === "income" ? "收入" : "支出"}
          {(slice?.percentage ?? 0).toFixed(1)}%
        </p>
      </div>

      <div class="mt-5">
        <p class="text-caption font-semibold text-subtle">近 6 個月</p>
        <div
          class="mt-2 grid grid-cols-6 gap-2"
          data-testid="category-sheet-six-month"
        >
          {#each series as point (point.month)}
            <div
              data-testid="category-sheet-month-bar"
              class={`grid min-w-0 justify-items-center gap-1 rounded-md px-1 pb-1.5 pt-2 text-center ${point.month === selectedMonth ? "bg-ink/5" : ""}`}
            >
              <div class="flex h-14 w-full items-end justify-center">
                <span
                  class={`w-2/3 rounded-t-sm ${flow === "income" ? "bg-moss" : "bg-coral"} ${point.month === selectedMonth ? "" : "opacity-45"}`}
                  style={`height:${Math.max(4, (Math.max(point.amount, 0) / maxSeries) * 100)}%`}
                ></span>
              </div>
              <span
                class="w-full truncate text-[10px] font-semibold text-subtle"
                >{Number(point.month.slice(5))} 月</span
              >
            </div>
          {/each}
        </div>
      </div>

      <div class="mt-5 border-t border-ink/10 pt-3">
        <p class="pb-2 text-caption font-semibold text-subtle">
          {monthLabel}活動 · {rows.length} 筆
        </p>
        {#if rows.length === 0}
          <p class="py-6 text-center text-sm text-subtle">
            這個月沒有這個分類的活動
          </p>
        {:else}
          <div class="divide-y divide-ink/8">
            {#each rows as row (row.item.source + "-" + row.item.id)}
              <button
                type="button"
                aria-label={`查看 ${row.item.title} 活動詳情`}
                class="flex w-full min-w-0 items-center gap-3 py-3 text-left transition hover:bg-ink/3"
                onclick={() => onOpenDetail(row.item)}
              >
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-semibold">
                    {row.item.title}
                  </p>
                  <p class="mt-0.5 truncate text-caption text-subtle">
                    {formatActivityDate(row.item)}
                  </p>
                  <p class="mt-0.5 truncate text-caption text-subtle">
                    {[
                      row.item.institutionName ?? sourceLabel(row.item),
                      row.item.accountName,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <p
                  class={`shrink-0 text-right text-sm font-semibold tabular-nums ${(flow === "expense") === row.amount > 0 ? "text-coral" : "text-moss"}`}
                >
                  {flowAmountSign(flow, row.amount)}{formatCurrency(
                    Math.abs(row.amount),
                  )}
                </p>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <footer class="shrink-0 border-t border-ink/10 px-5 py-4">
      <Button class="h-12 w-full" onclick={onFilter}>在列表中篩選</Button>
    </footer>
  </div>
</div>
