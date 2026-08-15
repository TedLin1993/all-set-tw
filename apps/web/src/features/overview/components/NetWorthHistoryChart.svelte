<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowDownLeft, ArrowUpRight, TrendingUp } from "@lucide/svelte";
  import { LineChart } from "layerchart";
  import Card from "@/shared/ui/Card.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import TabsList from "@/shared/ui/TabsList.svelte";
  import TabsTrigger from "@/shared/ui/TabsTrigger.svelte";
  import {
    ChartContainer,
    ChartTooltip,
    type ChartConfig,
  } from "@/shared/ui/chart";
  import {
    formatCompactTwd,
    formatCurrency,
    formatDate,
  } from "@/shared/format/financial";
  import {
    buildNetWorthChartData,
    getNetWorthComparison,
    getAvailableNetWorthAssets,
    NET_WORTH_COMPARISON_PERIODS,
    NET_WORTH_ASSET_SERIES,
    NET_WORTH_DEFAULT_ASSETS,
    type NetWorthAssetType,
    type NetWorthChartPoint,
    type NetWorthDisplayMode,
    type NetWorthComparisonPeriod,
    type NetWorthTimeframe,
  } from "../model/net-worth-chart";
  import type { NetWorthHistoryRow } from "@/data/assets/types";

  let {
    data = [],
    loading = false,
  }: { data?: NetWorthHistoryRow[]; loading?: boolean } = $props();

  const storageKey = "taiwan-fin-hub-net-worth-chart-included-assets";
  const timeframes: NetWorthTimeframe[] = ["1M", "3M", "6M", "1Y", "ALL"];
  const chartConfig: ChartConfig = {
    selectedTotal: { label: "淨資產", color: "#3e6f7c" },
    stock: { label: "股票/ETF", color: "#6574cd" },
    fund: { label: "基金", color: "#9b6bb0" },
    deposit: { label: "存款", color: "#3e6f7c" },
    manual: { label: "其他資產", color: "#b5853f" },
  };

  let includedAssets = $state<NetWorthAssetType[]>([
    ...NET_WORTH_DEFAULT_ASSETS,
  ]);
  let timeframe = $state<NetWorthTimeframe>("1Y");
  let displayMode = $state<NetWorthDisplayMode>("sum");
  let comparisonPeriod = $state<NetWorthComparisonPeriod>("day");

  const availableAssets = $derived(getAvailableNetWorthAssets(data));
  const chartData = $derived(
    buildNetWorthChartData(data, includedAssets, timeframe),
  );
  const comparisonData = $derived(
    buildNetWorthChartData(data, includedAssets, "ALL"),
  );
  const firstValue = $derived(chartData[0]?.selectedTotal ?? 0);
  const latestValue = $derived(chartData.at(-1)?.selectedTotal ?? 0);
  const changeValue = $derived(latestValue - firstValue);
  const changePercent = $derived(
    firstValue === 0 ? 0 : (changeValue / Math.abs(firstValue)) * 100,
  );
  const comparison = $derived(
    getNetWorthComparison(comparisonData, comparisonPeriod),
  );
  const comparisonOption = $derived(
    NET_WORTH_COMPARISON_PERIODS.find(
      (option) => option.key === comparisonPeriod,
    ),
  );
  const chartSeries = $derived(
    displayMode === "sum"
      ? [
          {
            key: "selectedTotal",
            label: "淨資產",
            value: "selectedTotal",
            color: "var(--color-selectedTotal)",
          },
        ]
      : [
          ...NET_WORTH_ASSET_SERIES.filter(({ key }) =>
            includedAssets.includes(key),
          ).map(({ key, label }) => ({
            key,
            label,
            value: key,
            color: `var(--color-${key})`,
          })),
          {
            key: "selectedTotal",
            label: "總和",
            value: "selectedTotal",
            color: "var(--color-selectedTotal)",
            props: { "stroke-dasharray": "6 4", strokeWidth: 2.5 },
          },
        ],
  );

  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (!Array.isArray(saved)) return;
      const valid = saved.filter((value): value is NetWorthAssetType =>
        ["stock", "fund", "deposit", "manual"].includes(value),
      );
      if (valid.length) includedAssets = valid;
    } catch {
      /* keep defaults */
    }
  });

  function toggleAsset(asset: NetWorthAssetType) {
    if (!availableAssets.has(asset)) return;
    const next = includedAssets.includes(asset)
      ? includedAssets.filter((item) => item !== asset)
      : [...includedAssets, asset];
    if (next.length === 0) return;
    includedAssets = next;
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  function xValue(point: NetWorthChartPoint) {
    return new Date(`${point.date}T00:00:00`);
  }

  function formatAxisDate(value: unknown) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-TW", {
      month: "numeric",
      day: "numeric",
    }).format(date);
  }
</script>

{#snippet chartTooltip()}
  <ChartTooltip
    indicator={displayMode === "sum" ? "dot" : "line"}
    labelFormatter={(value) =>
      formatDate(value instanceof Date ? value.toISOString() : String(value))}
    valueFormatter={(value) => formatCurrency(Number(value))}
  />
{/snippet}

<Card class="min-w-0 max-w-full overflow-hidden">
  <CardHeader class="gap-3 p-4 md:p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="flex items-center gap-2 text-base font-semibold">
          <TrendingUp class="size-4 text-steel" />資產走勢
        </h2>
        <div
          class="flex flex-wrap items-center gap-1.5"
          aria-label="資產類型篩選"
        >
          <span class="text-xs font-medium text-ink/40">包含</span>
          {#each NET_WORTH_ASSET_SERIES as option (option.key)}
            {@const active = includedAssets.includes(option.key)}
            {@const available = availableAssets.has(option.key)}
            <button
              class={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition ${active && available ? "border-ink/15 bg-white text-ink shadow-xs" : "border-ink/8 bg-paper text-ink/45"} ${available ? "hover:border-steel/25 hover:text-steel" : "cursor-not-allowed opacity-40"}`}
              disabled={!available}
              aria-pressed={active}
              onclick={() => toggleAsset(option.key)}
              ><span
                class="size-2 rounded-full"
                style={`background:${option.color}`}
              ></span>{option.label}</button
            >
          {/each}
        </div>
        <TabsList class="h-8 border border-border p-0.5 text-xs">
          {#each [{ key: "sum", label: "總和" }, { key: "breakdown", label: "分類" }] as option (option.key)}
            <TabsTrigger
              class="h-7 px-2 py-0.5 text-xs"
              active={displayMode === option.key}
              onclick={() => (displayMode = option.key as NetWorthDisplayMode)}
              >{option.label}</TabsTrigger
            >
          {/each}
        </TabsList>
      </div>
      <div class="flex items-center gap-2">
        {#if chartData.length > 0}
          <span
            class={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold ${changeValue >= 0 ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}
          >
            {#if changeValue >= 0}<ArrowUpRight
                class="size-3.5"
              />{:else}<ArrowDownLeft class="size-3.5" />{/if}
            {changePercent >= 0 ? "+" : ""}{changePercent.toFixed(1)}%
          </span>
        {/if}
        <TabsList
          class="grid h-8 grid-cols-5 border border-border p-0.5 text-xs"
        >
          {#each timeframes as option (option)}
            <TabsTrigger
              class="h-7 px-2 py-0.5 text-xs"
              active={timeframe === option}
              onclick={() => (timeframe = option)}
              >{option === "ALL" ? "全部" : option}</TabsTrigger
            >
          {/each}
        </TabsList>
      </div>
    </div>
  </CardHeader>
  <CardContent class="min-w-0 overflow-hidden px-3 pb-4 sm:px-5 sm:pb-5">
    {#if loading}
      <div class="flex h-64 items-center justify-center text-sm text-ink/45">
        載入趨勢中…
      </div>
    {:else if chartData.length === 0}
      <div
        class="flex h-64 items-center justify-center rounded-lg bg-ink/2 text-sm text-ink/45"
      >
        尚無淨資產歷史資料。
      </div>
    {:else}
      <ChartContainer
        config={chartConfig}
        class="h-52 min-h-52 w-full min-w-0 sm:h-56 sm:min-h-56"
      >
        <LineChart
          data={chartData}
          x={xValue}
          series={chartSeries}
          padding={{ top: 16, right: 18, bottom: 28, left: 48 }}
          yBaseline={null}
          yNice={true}
          axis={true}
          grid={false}
          tooltip={chartTooltip}
          props={{
            xAxis: {
              format: formatAxisDate,
              tickSpacing: 72,
              tickMarks: false,
            },
            yAxis: {
              format: (value: unknown) => formatCompactTwd(Number(value)),
              tickSpacing: 52,
              tickMarks: false,
              grid: true,
            },
            spline: { strokeWidth: 2.5 },
            highlight: { points: true, lines: true },
          }}
        />
      </ChartContainer>
      <div
        class="mt-2 flex min-w-0 flex-wrap items-center gap-3 border-t border-ink/8 pt-3"
      >
        {#if displayMode === "breakdown"}
          <div class="flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink/55">
            <span class="inline-flex items-center gap-1.5"
              ><span class="w-4 border-t-2 border-dashed border-ink"
              ></span>總和</span
            >
            {#each NET_WORTH_ASSET_SERIES.filter( ({ key }) => includedAssets.includes(key) ) as item (item.key)}
              <span class="inline-flex items-center gap-1.5"
                ><span
                  class="size-2 rounded-full"
                  style={`background:${item.color}`}
                ></span>{item.label}</span
              >
            {/each}
          </div>
        {:else}
          <span class="text-xs text-ink/45">已選資產的每日合計</span>
        {/if}
      </div>
      <div
        class="mt-3 grid min-w-0 gap-3 border-t border-ink/8 pt-3 md:grid-cols-[auto_minmax(18rem,28rem)] md:items-start md:justify-between"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="shrink-0 text-xs font-semibold text-ink/50">比較</span>
          <TabsList
            class="grid h-8 grid-cols-3 border border-border p-0.5 text-xs"
          >
            {#each NET_WORTH_COMPARISON_PERIODS as option (option.key)}
              <TabsTrigger
                class="h-7 px-2 py-0.5 text-xs"
                active={comparisonPeriod === option.key}
                onclick={() => (comparisonPeriod = option.key)}
                >{option.label}</TabsTrigger
              >
            {/each}
          </TabsList>
        </div>
        {#if comparison && comparisonOption}
          {@const comparisonSign = comparison.changeValue > 0 ? "+" : ""}
          <div class="grid min-w-0 gap-2 rounded-lg bg-paper px-3 py-3 text-sm">
            <div
              class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3"
            >
              <span class="text-ink/45">目前</span>
              <span
                class="whitespace-nowrap text-right font-semibold text-ink/70 tabular-nums sm:text-base"
                >{formatCurrency(comparison.currentValue)}</span
              >
            </div>
            <div
              class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
            >
              <span class="min-w-0">
                <span class="block font-medium text-ink/50"
                  >{comparisonOption.label}</span
                >
                <span class="mt-0.5 block text-xs text-ink/40">
                  {formatDate(comparison.previousDate)}
                </span>
              </span>
              <span
                class="whitespace-nowrap text-right font-semibold text-ink/70 tabular-nums sm:text-base"
                >{formatCurrency(comparison.previousValue)}</span
              >
            </div>
            <div
              class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-t border-ink/8 pt-1.5"
            >
              <span class="font-semibold text-ink/50">變化</span>
              <span
                class={`whitespace-nowrap text-right font-semibold tabular-nums sm:text-base ${comparison.changeValue > 0 ? "text-moss" : comparison.changeValue < 0 ? "text-coral" : "text-ink/55"}`}
              >
                {comparison.changeValue < 0
                  ? ""
                  : comparisonSign}{formatCurrency(comparison.changeValue)}
                {#if comparison.changePercent !== null}
                  （{comparison.changePercent > 0
                    ? "+"
                    : comparison.changePercent < 0
                      ? "−"
                      : ""}{Math.abs(comparison.changePercent).toFixed(1)}%）
                {/if}
              </span>
            </div>
          </div>
        {:else}
          <p class="text-xs text-ink/40">
            尚無{comparisonOption?.label ?? "目標"}的有效快照
          </p>
        {/if}
      </div>
    {/if}
  </CardContent>
</Card>
