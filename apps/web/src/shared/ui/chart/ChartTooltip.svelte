<script lang="ts">
  import { onMount } from "svelte";
  import { getChartContext, Tooltip as TooltipPrimitive } from "layerchart";
  import { cn } from "@/shared/utils/cn";
  import { useChart } from "./chart-utils";

  let {
    class: className,
    labelFormatter = (value: unknown) => String(value ?? ""),
    titleFormatter,
    valueFormatter = (value: unknown) => String(value ?? ""),
    hideItemLabel = false,
    focusedKey = null,
    indicator = "dot",
    footer,
  }: {
    /** 由該點資料算出的附加列（例如市值減成本的損益）；回傳 null 時不顯示。 */
    footer?: (
      data: unknown,
    ) => { label: string; value: string; class?: string } | null;
    class?: string;
    labelFormatter?: (value: unknown) => string;
    titleFormatter?: (data: unknown, header: unknown) => string;
    valueFormatter?: (value: unknown, key: string) => string;
    hideItemLabel?: boolean;
    focusedKey?: string | null;
    indicator?: "dot" | "line";
  } = $props();

  const chart = useChart();
  const context = getChartContext();
  onMount(() => {
    const dismiss = () => {
      context.tooltip.isHoveringTooltipContent = false;
      context.tooltip.hide();
    };
    // Capture also catches scroll events from the app's nested scroll containers.
    window.addEventListener("scroll", dismiss, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointercancel", dismiss, { capture: true });
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("pointercancel", dismiss, true);
    };
  });
  const visibleSeries = $derived(
    context.tooltip.series.filter((series) => series.visible),
  );
  const footerItem = $derived(
    footer && context.tooltip.data ? footer(context.tooltip.data) : null,
  );
  const header = $derived(
    context.tooltip.data ? context.x(context.tooltip.data) : undefined,
  );
</script>

<TooltipPrimitive.Root variant="none" portal={true}>
  <div
    class={cn(
      "grid min-w-40 gap-2 rounded-lg border border-ink/10 bg-card/95 px-3 py-2 text-xs text-ink shadow-xl backdrop-blur-sm",
      className,
    )}
  >
    <p class="font-semibold">
      {titleFormatter
        ? titleFormatter(context.tooltip.data, header)
        : labelFormatter(header)}
    </p>
    <div class="grid gap-1.5">
      {#each visibleSeries as series (series.key)}
        {@const itemConfig = chart.config[series.key]}
        {@const color = series.color ?? itemConfig?.color ?? "#3e6f7c"}
        <div
          class={cn(
            "grid items-center gap-2",
            focusedKey && focusedKey !== series.key ? "opacity-35" : "",
            hideItemLabel
              ? "grid-cols-[auto_auto] justify-between"
              : "grid-cols-[auto_minmax(0,1fr)_auto]",
          )}
        >
          <span
            class={cn(
              "shrink-0 rounded-sm",
              indicator === "line" ? "h-0.5 w-3" : "size-2.5",
            )}
            style={`background-color: ${color}`}
          ></span>
          {#if !hideItemLabel}<span class="text-ink/55"
              >{itemConfig?.label ?? series.label ?? series.key}</span
            >{/if}
          <span class="font-semibold tabular-nums"
            >{valueFormatter(series.value, series.key)}</span
          >
        </div>
      {/each}
    </div>
    {#if footerItem}
      <div
        class="flex items-center justify-between gap-2 border-t border-ink/10 pt-1.5"
      >
        <span class="text-ink/55">{footerItem.label}</span>
        <span class={cn("font-semibold tabular-nums", footerItem.class)}
          >{footerItem.value}</span
        >
      </div>
    {/if}
  </div>
</TooltipPrimitive.Root>
