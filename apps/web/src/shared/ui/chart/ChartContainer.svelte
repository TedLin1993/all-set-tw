<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "@/shared/utils/cn";
  import ChartStyle from "./ChartStyle.svelte";
  import { setChartContext, type ChartConfig } from "./chart-utils";

  const uid = $props.id();
  let {
    config,
    children,
    class: className,
    ...rest
  }: HTMLAttributes<HTMLDivElement> & {
    config: ChartConfig;
    children?: Snippet;
  } = $props();
  const chartId = `chart-${uid.replace(/:/g, "")}`;

  setChartContext({
    get config() {
      return config;
    },
  });
</script>

<div
  data-chart={chartId}
  data-slot="chart"
  class={cn(
    "flex w-full justify-center overflow-visible text-xs",
    "[&_.lc-root-container]:w-full [&_.lc-axis-tick]:stroke-0",
    "[&_.lc-axis-tick-label]:fill-subtle [&_.lc-axis-tick-label]:text-xs [&_.lc-axis-tick-label]:font-normal",
    "[&_.lc-axis-grid]:stroke-ink/10 [&_.lc-highlight-line]:stroke-steel/30",
    "[&_.lc-highlight-point]:stroke-card [&_.lc-highlight-point]:stroke-2",
    "[&_.lc-path]:transition-opacity [&_.lc-text-svg]:overflow-visible",
    className,
  )}
  {...rest}
>
  <ChartStyle id={chartId} {config} />
  {@render children?.()}
</div>
