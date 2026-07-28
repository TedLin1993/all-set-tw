<script lang="ts">
  import { SvelteDate } from "svelte/reactivity";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { Search } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import EmptyState from "@/shared/ui/EmptyState.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import { exchangeRatesQuery } from "@/data/assets/queries";
  import { bankQuery } from "@/data/bank/queries";
  import type { BankTransactionRow } from "@/data/bank/types";
  import { classificationCategoriesQuery } from "@/data/classification/queries";
  import type { View } from "@/app/types";
  import {
    formatBankAccountName,
    formatCurrency,
    formatCurrencyTotals,
    formatDate,
    rateMap,
    transactionValueTwd,
  } from "@/shared/format/financial";
  let { api, navigate }: { api: ApiClient; navigate: (view: View) => void } =
    $props();
  const bank = createQuery(bankQuery(() => api));
  const rates = createQuery(exchangeRatesQuery(() => api));
  const categoryRows = createQuery(classificationCategoriesQuery(() => api));
  const qc = useQueryClient();
  let search = $state("");
  let account = $state("all");
  let flow = $state<"all" | "inflow" | "outflow">("all");
  let range = $state<"month" | "threeMonths" | "year" | "all">("month");
  let selected = $state<BankTransactionRow | null>(null);
  let ruleForm = $state({
    pattern: "",
    operator: "contains" as "contains" | "equals",
  });
  const rateValues = $derived(rateMap($rates.data));
  const accounts = $derived($bank.data?.accounts ?? []);
  const transactions = $derived($bank.data?.transactions ?? []);
  const filtered = $derived(
    transactions.filter(
      (t) =>
        (account === "all" || t.accountId === account) &&
        (flow === "all" ||
          (flow === "inflow" ? t.amount >= 0 : t.amount < 0)) &&
        (!search.trim() ||
          `${t.description ?? ""} ${t.counterparty ?? ""} ${t.institutionName ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        inRange(t),
    ),
  );
  const totals = $derived(
    accounts.reduce<Record<string, number>>((s, a) => {
      const c = a.currency || "TWD";
      s[c] = (s[c] ?? 0) + (a.balance ?? 0);
      return s;
    }, {}),
  );
  const cashFlow = $derived({
    inflow: filtered
      .filter((t) => t.amount >= 0 && !t.excludedFromCalculation)
      .reduce((s, t) => s + transactionValueTwd(t, rateValues), 0),
    outflow: filtered
      .filter((t) => t.amount < 0 && !t.excludedFromCalculation)
      .reduce((s, t) => s + transactionValueTwd(t, rateValues), 0),
  });
  const override = createMutation({
    mutationFn: async ({
      id,
      categoryId,
    }: {
      id: string;
      categoryId: string;
    }) =>
      api.put(`/api/classification/overrides/bank_transaction/${id}`, {
        categoryId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.bank });
      selected = null;
    },
  });
  const clearOverride = createMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/classification/overrides/bank_transaction/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.bank });
      selected = null;
    },
  });
  const addRule = createMutation({
    mutationFn: async ({
      categoryId,
      pattern,
      operator,
    }: {
      categoryId: string;
      pattern: string;
      operator: string;
    }) =>
      api.post("/api/classification/rules", {
        categoryId,
        targetType: "bank_transaction",
        field: "any_text",
        operator,
        pattern,
        priority: 200,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.bank });
      qc.invalidateQueries({ queryKey: queryKeys.classificationRules });
      selected = null;
    },
  });
  const fallbackCategories = [
    { id: "salary", label: "薪資" },
    { id: "transfer", label: "轉帳" },
    { id: "food", label: "餐飲" },
    { id: "transport", label: "交通" },
    { id: "shopping", label: "購物" },
    { id: "housing", label: "居住" },
    { id: "health", label: "醫療" },
    { id: "education", label: "教育" },
    { id: "entertainment", label: "娛樂" },
    { id: "investment", label: "投資" },
    { id: "insurance", label: "保險" },
    { id: "fee", label: "手續費" },
    { id: "tax", label: "稅務" },
    { id: "other", label: "未分類" },
  ];
  const categoryOptions = $derived(
    $categoryRows.data?.length ? $categoryRows.data : fallbackCategories,
  );
  const categoryLabels = $derived(
    Object.fromEntries(
      categoryOptions.map((category) => [category.id, category.label]),
    ),
  );
  function inRange(t: BankTransactionRow) {
    if (range === "all") return true;
    const date = new Date(t.postedDate ?? t.authorizedAt ?? "");
    const months = range === "month" ? 1 : range === "threeMonths" ? 3 : 12;
    const start = new SvelteDate();
    start.setMonth(start.getMonth() - months + 1);
    return date >= start;
  }
  function selectTransaction(t: BankTransactionRow) {
    selected = t;
    ruleForm = {
      pattern: t.description ?? t.counterparty ?? "",
      operator: "contains",
    };
  }
</script>

{#if $bank.isPending}<EmptyState
    title="載入銀行資料中"
    body="正在讀取帳戶與交易。"
  />{:else}<div class="grid gap-5">
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div class="rounded-xl border border-ink/10 bg-white p-4 shadow-xs">
        <p class="text-xs text-ink/45">帳戶數</p>
        <p class="mt-2 text-xl font-bold">{accounts.length}</p>
      </div>
      <div class="rounded-xl border border-ink/10 bg-white p-4 shadow-xs">
        <p class="text-xs text-ink/45">帳戶餘額</p>
        <p class="mt-2 text-xl font-bold">{formatCurrencyTotals(totals)}</p>
      </div>
      <div class="rounded-xl border border-ink/10 bg-white p-4 shadow-xs">
        <p class="text-xs text-ink/45">本期收入</p>
        <p class="mt-2 text-xl font-bold text-moss">
          {formatCurrency(cashFlow.inflow)}
        </p>
      </div>
      <div class="rounded-xl border border-ink/10 bg-white p-4 shadow-xs">
        <p class="text-xs text-ink/45">本期支出</p>
        <p class="mt-2 text-xl font-bold text-coral">
          {formatCurrency(Math.abs(cashFlow.outflow))}
        </p>
      </div>
    </div>
    <Card
      ><CardHeader class="gap-3"
        ><div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold">銀行交易</h2>
            <p class="text-xs text-ink/45">共 {filtered.length} 筆符合條件</p>
          </div>
          <label
            class="flex min-h-10 items-center gap-2 rounded-md border border-input bg-background px-3 shadow-xs focus-within:ring-2 focus-within:ring-ring"
            ><Search class="size-4 text-steel" /><Input
              class="h-auto w-48 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder="搜尋交易"
              bind:value={search}
            /></label
          >
        </div>
        <div class="flex flex-wrap gap-2">
          <Select class="w-auto" bind:value={account}
            ><option value="all">全部帳戶</option
            >{#each accounts as a (a.id)}<option value={a.id}
                >{a.institutionName ?? a.accountName ?? a.id}</option
              >{/each}</Select
          ><Select class="w-auto" bind:value={flow}
            ><option value="all">全部流向</option><option value="inflow"
              >收入</option
            ><option value="outflow">支出</option></Select
          ><Select class="w-auto" bind:value={range}
            ><option value="month">本月</option><option value="threeMonths"
              >近三個月</option
            ><option value="year">今年</option><option value="all">全部</option
            ></Select
          >
        </div></CardHeader
      ><CardContent class="p-0"
        ><div class="divide-y divide-ink/8">
          {#if filtered.length === 0}<p
              class="p-8 text-center text-sm text-ink/50"
            >
              沒有符合條件的交易。
            </p>{:else}{#each filtered.slice(0, 200) as t (t.id)}<button
                class="flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-paper"
                onclick={() => selectTransaction(t)}
                ><div class="min-w-0">
                  <p class="truncate text-sm font-semibold">
                    {t.description ?? t.counterparty ?? "銀行交易"}
                  </p>
                  <p class="mt-1 truncate text-xs text-ink/40">
                    {formatBankAccountName(t)} · {formatDate(
                      t.postedDate ?? t.authorizedAt,
                    )} · {t.classification?.label ?? "未分類"}
                  </p>
                </div>
                <p
                  class={`shrink-0 text-sm font-bold tabular-nums ${t.amount < 0 ? "text-coral" : "text-moss"}`}
                >
                  {t.amount >= 0 ? "+" : ""}{formatCurrency(
                    t.amount,
                    t.currency,
                  )}
                </p></button
              >{/each}{/if}
        </div></CardContent
      ></Card
    >
    <div class="flex justify-end">
      <Button variant="ghost" onclick={() => navigate("settings")}
        >管理匯率與分類規則 →</Button
      >
    </div>
    {#if selected}<div
        class="fixed inset-0 z-[70] flex items-end bg-ink/45 md:items-center md:justify-center md:p-6"
      >
        <div
          class="w-full rounded-t-2xl bg-white p-5 shadow-2xl md:max-w-lg md:rounded-2xl"
        >
          <div class="flex items-start justify-between">
            <div>
              <p class="text-xs font-semibold text-steel">交易分類</p>
              <h2 class="mt-1 text-xl font-semibold">
                {selected.description ?? selected.counterparty ?? "銀行交易"}
              </h2>
              <p class="mt-1 text-sm text-ink/50">
                目前分類：{selected.classification?.label ?? "未分類"}
              </p>
            </div>
            <Button
              aria-label="關閉"
              class="rounded-full text-xl"
              size="icon"
              variant="ghost"
              onclick={() => (selected = null)}>×</Button
            >
          </div>
          <Select
            class="mt-5"
            onchange={(e: Event) =>
              $override.mutate({
                id: selected!.id,
                categoryId: (e.currentTarget as HTMLSelectElement).value,
              })}
            >{#each categoryOptions as category (category.id)}<option
                value={category.id}
                selected={category.id ===
                  (selected.classification?.categoryId ?? "other")}
                >{category.label}</option
              >{/each}</Select
          >{#if selected.classification?.source === "override"}<Button
              class="mt-3"
              size="sm"
              variant="secondary"
              onclick={() => $clearOverride.mutate(selected!.id)}
              >清除分類覆寫</Button
            >{/if}
          <div class="mt-4 rounded-xl border border-steel/20 bg-steel/5 p-4">
            <p class="text-sm font-semibold">建立規則</p>
            <Input class="mt-2" bind:value={ruleForm.pattern} />
            <div class="mt-3 flex gap-2">
              <Select class="w-auto" bind:value={ruleForm.operator}
                ><option value="contains">包含</option><option value="equals"
                  >完全等於</option
                ></Select
              ><Button
                size="sm"
                onclick={() =>
                  $addRule.mutate({
                    categoryId: selected?.classification?.categoryId ?? "other",
                    ...ruleForm,
                  })}>新增規則</Button
              >
            </div>
          </div>
        </div>
      </div>{/if}
  </div>{/if}
