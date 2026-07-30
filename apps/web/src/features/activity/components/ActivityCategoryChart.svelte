<script lang="ts">
  import { PieChart } from "layerchart";
  import Card from "@/shared/ui/Card.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import {
    ChartContainer,
    ChartTooltip,
    type ChartConfig,
  } from "@/shared/ui/chart";
  import { formatCompactTwd, formatCurrency } from "@/shared/format/financial";
  import type { ActivityCategorySlice, ActivityFlow } from "../model/chart";

  let {
    flow,
    slices,
    selectedCategory,
    flowSelected,
    onSelect,
    onSelectFlow,
  }: {
    flow: ActivityFlow;
    slices: ActivityCategorySlice[];
    selectedCategory?: string;
    flowSelected: boolean;
    onSelect: (category: string) => void;
    onSelectFlow: () => void;
  } = $props();

  const title = $derived(flow === "income" ? "收入分類" : "支出分類");
  const flowLabel = $derived(flow === "income" ? "收入" : "支出");
  const total = $derived(slices.reduce((sum, slice) => sum + slice.amount, 0));
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

<Card
  class={`min-w-0 overflow-hidden ${flow === "income" ? "border-moss/20" : "border-coral/20"}`}
>
  <CardHeader class="flex-row items-start justify-between gap-3 pb-2">
    <div class="min-w-0">
      <h3
        class={`font-semibold ${flow === "income" ? "text-moss" : "text-coral"}`}
      >
        {title}
      </h3>
      <p class="mt-1 text-xs text-ink/45">點選分類查看該月活動</p>
    </div>
    <p
      class={`shrink-0 text-base font-bold tabular-nums sm:text-lg ${flow === "income" ? "text-moss" : "text-coral"}`}
    >
      {flow === "income" ? "+" : "−"}{formatCurrency(total)}
    </p>
  </CardHeader>
  <CardContent class="pt-2">
    {#if slices.length === 0}
      <div class="rounded-xl bg-paper p-6 text-center text-sm text-ink/45">
        此月份沒有{flow === "income" ? "收入" : "支出"}活動
      </div>
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
              props={{ arc: { stroke: "white", strokeWidth: 2 } }}
            />
          </ChartContainer>
          <button
            type="button"
            aria-label={flowSelected ? "顯示全部活動" : `查看${flowLabel}活動`}
            aria-pressed={flowSelected}
            class={`absolute left-1/2 top-1/2 z-10 flex size-20 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steel focus-visible:ring-offset-2 ${flowSelected ? "bg-steel/10 ring-2 ring-steel/25" : "hover:bg-paper"}`}
            onclick={onSelectFlow}
          >
            <span class="text-[11px] font-semibold text-steel">
              {flowSelected ? "顯示全部" : `查看${flowLabel}`}
            </span>
            <span class="mt-0.5 text-sm font-bold tabular-nums"
              >{formatCompactTwd(total)}</span
            >
          </button>
        </div>
        <div class="grid min-w-0 gap-1.5">
          {#each slices as slice (slice.category)}
            <button
              aria-pressed={selectedCategory === slice.category}
              class={`grid min-h-11 min-w-0 grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 text-left transition ${selectedCategory === slice.category ? "bg-steel/10 ring-1 ring-steel/20" : "hover:bg-paper"}`}
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
                <span class="block text-xs font-bold tabular-nums"
                  >{slice.percentage.toFixed(1)}%</span
                >
                <span class="block text-[10px] text-ink/40 tabular-nums"
                  >{formatCurrency(slice.amount)}</span
                >
              </span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </CardContent>
</Card>
