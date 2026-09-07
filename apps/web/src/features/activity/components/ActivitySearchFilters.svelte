<script lang="ts">
  import { SlidersHorizontal, X } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import type {
    ActivityFlowFilter,
    ActivitySourceFilter,
  } from "../model/filter";
  let {
    time = $bindable("all"),
    from = $bindable(""),
    to = $bindable(""),
    source = $bindable<ActivitySourceFilter>("all"),
    flow = $bindable<ActivityFlowFilter>("all"),
    category = $bindable(""),
    categories,
  }: {
    time?: string;
    from?: string;
    to?: string;
    source?: ActivitySourceFilter;
    flow?: ActivityFlowFilter;
    category?: string;
    categories: { id: string; label: string }[];
  } = $props();
  let open = $state(false);
  const times = [
    { id: "all", label: "全部時間" },
    { id: "year", label: "今年" },
    { id: "12months", label: "最近 12 個月" },
    { id: "custom", label: "自訂日期" },
  ];
  const sources = [
    { id: "all", label: "所有來源" },
    { id: "bank", label: "銀行" },
    { id: "card", label: "信用卡" },
    { id: "invoice", label: "發票" },
  ];
  function focusSheet(node: HTMLDivElement) {
    const previous = document.activeElement as HTMLElement | null;
    const elements = () => [
      ...node.querySelectorAll<HTMLElement>(
        "button:not(:disabled), select, input",
      ),
    ];
    elements()[0]?.focus();
    function trap(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const targets = elements();
      const first = targets[0];
      const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    node.addEventListener("keydown", trap);
    return {
      destroy() {
        node.removeEventListener("keydown", trap);
        previous?.focus();
      },
    };
  }
  function reset() {
    time = "all";
    from = "";
    to = "";
    source = "all";
    flow = "all";
    category = "";
  }
</script>

{#snippet fields()}
  <label class="grid gap-1 text-xs text-ink/60"
    >時間範圍<Select aria-label="搜尋時間範圍" class="h-11" bind:value={time}
      >{#each times as option}<option value={option.id}>{option.label}</option
        >{/each}</Select
    ></label
  >
  {#if time === "custom"}
    <label class="grid min-w-0 gap-1 text-xs text-ink/60"
      >開始日期<Input
        aria-label="搜尋開始日期"
        type="date"
        class="h-11 min-w-0"
        bind:value={from}
      /></label
    >
    <label class="grid min-w-0 gap-1 text-xs text-ink/60"
      >結束日期<Input
        aria-label="搜尋結束日期"
        type="date"
        class="h-11 min-w-0"
        bind:value={to}
      /></label
    >
  {/if}
  <label class="grid gap-1 text-xs text-ink/60"
    >來源<Select aria-label="搜尋來源" class="h-11" bind:value={source}
      >{#each sources as option}<option value={option.id}>{option.label}</option
        >{/each}</Select
    ></label
  >
  <label class="grid gap-1 text-xs text-ink/60"
    >收支<Select aria-label="搜尋收支" class="h-11" bind:value={flow}
      ><option value="all">全部收支</option><option value="income">收入</option
      ><option value="expense">支出</option></Select
    ></label
  >
  <label class="grid gap-1 text-xs text-ink/60"
    >分類<Select aria-label="搜尋分類" class="h-11" bind:value={category}
      ><option value="">所有分類</option>{#each categories as option}<option
          value={option.id}>{option.label}</option
        >{/each}<option value="invoice">發票</option><option value="investment"
        >投資活動</option
      ></Select
    ></label
  >
{/snippet}

<div class="hidden flex-wrap items-end gap-3 md:flex">{@render fields()}</div>
<div class="flex flex-wrap items-center gap-2">
  <Button
    variant="outline"
    class="h-11 gap-2 md:hidden"
    onclick={() => (open = true)}
    ><SlidersHorizontal class="size-4" />篩選</Button
  >
  <span class="rounded-full bg-steel/10 px-3 py-2 text-xs"
    >{time === "custom"
      ? `${from || "不限起日"} ～ ${to || "不限迄日"}`
      : times.find((t) => t.id === time)?.label}</span
  >
  {#if time !== "all"}<button
      class="min-h-11 text-xs text-steel"
      onclick={() => {
        time = "all";
        from = "";
        to = "";
      }}>清除時間 ×</button
    >{/if}
  {#if source !== "all"}<button
      class="min-h-11 rounded-full bg-paper px-3 text-xs"
      onclick={() => (source = "all")}
      >{sources.find((s) => s.id === source)?.label} ×</button
    >{/if}
  {#if flow !== "all"}<button
      class="min-h-11 rounded-full bg-paper px-3 text-xs"
      onclick={() => (flow = "all")}
      >{flow === "income" ? "收入" : "支出"} ×</button
    >{/if}
  {#if category}<button
      class="min-h-11 rounded-full bg-paper px-3 text-xs"
      onclick={() => (category = "")}
      >{categories.find((c) => c.id === category)?.label ?? "發票"} ×</button
    >{/if}
  {#if time !== "all" || source !== "all" || flow !== "all" || category}<button
      class="min-h-11 px-2 text-xs text-steel"
      onclick={reset}>清除篩選</button
    >{/if}
</div>
{#if open}
  <div
    class="fixed inset-0 z-[70] flex items-end bg-ink/40 md:hidden"
    role="presentation"
  >
    <button
      class="absolute inset-0"
      aria-label="關閉搜尋篩選"
      onclick={() => (open = false)}
    ></button>
    <div
      use:focusSheet
      role="dialog"
      aria-modal="true"
      aria-label="搜尋篩選"
      tabindex="-1"
      onkeydown={(e) => {
        if (e.key === "Escape") open = false;
      }}
      class="relative max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 pb-8"
    >
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">搜尋篩選</h2>
        <Button
          variant="ghost"
          aria-label="關閉篩選面板"
          onclick={() => (open = false)}><X class="size-5" /></Button
        >
      </div>
      <div class="grid grid-cols-1 gap-3">{@render fields()}</div>
      <Button class="mt-5 h-11 w-full" onclick={() => (open = false)}
        >查看結果</Button
      >
    </div>
  </div>
{/if}
