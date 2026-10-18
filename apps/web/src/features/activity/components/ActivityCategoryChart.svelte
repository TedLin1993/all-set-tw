<script lang="ts">
  import { PieChart } from "layerchart";
  import {
    ChartContainer,
    ChartTooltip,
    type ChartConfig,
  } from "@/shared/ui/chart";
  import {
    flowAmountSign,
    formatCompactTwd,
    formatCurrency,
  } from "@/shared/format/financial";
  import type { ActivityCategorySlice, ActivityFlow } from "../model/chart";

  let {
    flow,
    slices,
    total,
    selectedCategory,
    flowSelected,
    dataIncomplete = false,
    onSelect,
    onSelectFlow,
  }: {
    flow: ActivityFlow;
    slices: ActivityCategorySlice[];
    /** Net flow total; can be below the slices when refunds cover a category. */
    total: number;
    selectedCategory?: string;
    flowSelected: boolean;
    dataIncomplete?: boolean;
    onSelect: (category: string) => void;
    onSelectFlow: () => void;
  } = $props();

  const title = $derived(flow === "income" ? "收入分類" : "支出分類");
  const flowLabel = $derived(flow === "income" ? "收入" : "支出");
  const chartConfig: ChartConfig = {
    default: { label: "金額", color: "#3e6f7c" },
  };
</script>

{#snippet tooltip()}
  <ChartTooltip
    titleFormatter={(data) => {
      const slice = data as ActivityCategorySlice | undefined;
      return slice
        ? `${slice.category} · ${slice.percentage.toFixed(1)}%`
        : title;
    }}
    valueFormatter={(value) => formatCurrency(Number(value))}
    hideItemLabel={true}
  />
{/snippet}

<section class="min-w-0">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h3
        class={`text-base font-semibold ${flow === "income" ? "text-moss" : "text-coral"}`}
      >
        {title}
      </h3>
      <p class="mt-1 text-caption text-subtle">點選分類查看該月活動</p>
    </div>
    <p
      class={`shrink-0 whitespace-nowrap text-right text-lg font-semibold tracking-tight tabular-nums ${flow === "income" ? "text-moss" : "text-coral"}`}
    >
      {#if dataIncomplete}—{:else}{flowAmountSign(flow, total)}{formatCurrency(
          Math.abs(total),
        )}{/if}
    </p>
  </div>
  <div class="pt-4">
    {#if dataIncomplete}
      <div
        class="rounded-xl border border-amber-200/80 bg-amber-50 p-6 text-center text-sm text-amber-900"
      >
        活動資料尚未完整載入，分類比例暫不計算。
      </div>
    {:else if slices.length === 0}
      <p class="py-8 text-center text-sm text-subtle">
        {flow === "expense" && total !== 0
          ? "此月份沒有淨支出分類，退費已自支出總額扣除"
          : `此月份沒有${flow === "income" ? "收入" : "支出"}活動`}
      </p>
    {:else}
      <div
        class="grid min-w-0 gap-4 sm:grid-cols-[150px_minmax(0,1fr)] sm:items-center"
      >
        <div class="relative mx-auto size-36">
          <ChartContainer config={chartConfig} class="size-36 min-h-36">
            <PieChart
              data={slices}
              key="category"
              label="category"
              value="amount"
              c="color"
              innerRadius={0.62}
              cornerRadius={3}
              padAngle={0.025}
              {tooltip}
              onArcClick={(_, detail) =>
                onSelect((detail.data as ActivityCategorySlice).category)}
              props={{ arc: { stroke: "#f7f7f2", strokeWidth: 2 } }}
            />
          </ChartContainer>
          <button
            type="button"
            aria-label={flowSelected ? "顯示全部活動" : `查看${flowLabel}活動`}
            aria-pressed={flowSelected}
            class={`absolute left-1/2 top-1/2 z-10 flex size-20 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steel focus-visible:ring-offset-2 ${flowSelected ? "bg-steel/10 ring-2 ring-steel/25" : "hover:bg-ink/3"}`}
            onclick={onSelectFlow}
          >
            <span class="text-xs font-semibold text-steel">
              {flowSelected ? "顯示全部" : `查看${flowLabel}`}
            </span>
            <span class="mt-0.5 text-sm font-medium tabular-nums"
              >{total < 0 ? flowAmountSign(flow, total) : ""}{formatCompactTwd(
                Math.abs(total),
              )}</span
            >
          </button>
        </div>
        <div class="grid min-w-0 gap-1.5">
          {#each slices as slice (slice.category)}
            <button
              aria-pressed={selectedCategory === slice.category}
              class={`grid min-h-11 min-w-0 grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 text-left transition ${selectedCategory === slice.category ? "bg-ink/4 shadow-[inset_3px_0_0_var(--color-steel)]" : "hover:bg-ink/3"}`}
              onclick={() => onSelect(slice.category)}
            >
              <span
                class="size-2.5 rounded-full"
                style={`background-color:${slice.color}`}
              ></span>
              <span class="truncate text-sm font-semibold"
                >{slice.category}</span
              >
              <span class="text-right">
                <span class="block text-caption font-medium tabular-nums"
                  >{slice.percentage.toFixed(1)}%</span
                >
                <span class="block text-caption text-subtle tabular-nums"
                  >{formatCurrency(slice.amount)}</span
                >
              </span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</section>
