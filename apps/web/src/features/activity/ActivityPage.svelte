<script lang="ts">
  import { toStore } from "svelte/store";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import {
    Search,
    Building2,
    CreditCard,
    FileText,
    TrendingUp,
    ArrowDown,
    Check,
    Link2,
    Unlink2,
    ArrowLeft,
    ChevronRight,
    X,
  } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Checkbox from "@/shared/ui/Checkbox.svelte";
  import EmptyState from "@/shared/ui/EmptyState.svelte";
  import Badge from "@/shared/ui/Badge.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import TabsList from "@/shared/ui/TabsList.svelte";
  import TabsTrigger from "@/shared/ui/TabsTrigger.svelte";
  import ActivityCategoryChart from "./components/ActivityCategoryChart.svelte";
  import CategoryUpdateDialog from "./components/CategoryUpdateDialog.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import type { View } from "@/app/types";
  import { exchangeRatesQuery } from "@/data/assets/queries";
  import { bankRangeQuery } from "@/data/bank/queries";
  import type { BankData, BankTransactionRow } from "@/data/bank/types";
  import { classificationCategoriesQuery } from "@/data/classification/queries";
  import { investmentTransactionsRangeQuery } from "@/data/investments/queries";
  import {
    invoiceDetailQuery,
    invoiceTransactionMappingsQuery,
    invoicesRangeQuery,
  } from "@/data/invoices/queries";
  import type {
    InvoiceSummaryRow,
    InvoiceTransactionPreference,
  } from "@/data/invoices/types";
  import type { ActivityItem, PendingCategoryUpdate } from "./model/types";
  import {
    buildActivityCategorySlices,
    activityCashAmountTwd,
    activityCashFlow,
    activityDisplayAmount,
  } from "./model/chart";
  import {
    deduplicateBankTransactions,
    invoiceTransactionCandidates,
    matchInvoicesToTransactions,
  } from "@/data/activity/matching";
  import {
    formatCompactTwd,
    formatCurrency,
    formatDate,
    formatNumber,
    normalizeFinancialDate,
    rateMap,
  } from "@/shared/format/financial";
  import { recentMonthRange, recentMonthKeys } from "@/shared/date-range";
  import { swipeBack } from "@/shared/actions/swipe-back";
  let { api, navigate }: { api: ApiClient; navigate: (view: View) => void } =
    $props();
  const initialSelectedMonth = new Date().toISOString().slice(0, 7);
  let selectedMonth = $state(initialSelectedMonth);
  const activityRange = recentMonthRange(6);
  const bank = createQuery(bankRangeQuery(() => api, activityRange));
  const invoices = createQuery(invoicesRangeQuery(() => api, activityRange));
  const invoiceMappings = createQuery(
    invoiceTransactionMappingsQuery(() => api),
  );
  const trades = createQuery(
    investmentTransactionsRangeQuery(() => api, activityRange),
  );
  const rates = createQuery(exchangeRatesQuery(() => api));
  const categoryRows = createQuery(classificationCategoriesQuery(() => api));
  const qc = useQueryClient();
  let source = $state<"all" | "bank" | "card" | "invoice">("all");
  let search = $state("");
  let selectedCategory = $state<{
    flow: "income" | "expense";
    category: string;
  } | null>(null);
  let pending = $state<PendingCategoryUpdate | null>(null);
  let mappingDialog = $state<{
    invoice: InvoiceSummaryRow;
    step: "candidates" | "confirm" | "actions";
    transactionId?: string;
  } | null>(null);
  let mappingNotice = $state("");
  let detailKey = $state<string | null>(null);
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
    { id: "other", label: "其他" },
  ];
  const categoryOptions = $derived(
    $categoryRows.data?.length ? $categoryRows.data : fallbackCategories,
  );
  const categories = $derived(
    Object.fromEntries(
      categoryOptions.map((category) => [category.id, category.label]),
    ),
  );
  const rateValues = $derived(rateMap($rates.data));
  const bankAccounts = $derived(
    new Map(
      ($bank.data?.accounts ?? []).map((account) => [account.id, account]),
    ),
  );
  const activityBankTransactions = $derived(
    deduplicateBankTransactions(
      ($bank.data?.transactions ?? []).map((transaction) => ({
        ...transaction,
        accountType:
          transaction.accountType ??
          bankAccounts.get(transaction.accountId)?.accountType,
      })),
    ),
  );
  const invoiceMatches = $derived(
    matchInvoicesToTransactions(
      activityBankTransactions,
      $invoices.data ?? [],
      $invoiceMappings.data ?? [],
    ),
  );
  const rawItems = $derived<ActivityItem[]>(
    [
      ...activityBankTransactions.map((t) => {
        const account = bankAccounts.get(t.accountId);
        const matchedInvoice = invoiceMatches.transactionToInvoice.get(t.id);
        const isCard =
          account?.accountType === "credit" || t.accountType === "credit";
        const accountLabel =
          t.institutionName ??
          account?.institutionName ??
          t.accountName ??
          account?.accountName ??
          "";
        return {
          id: t.id,
          source: isCard ? ("card" as const) : ("bank" as const),
          date: t.authorizedAt ?? t.postedDate ?? "",
          title:
            matchedInvoice?.sellerName ??
            t.description ??
            t.counterparty ??
            "銀行交易",
          subtitle: [accountLabel, matchedInvoice?.invoiceNumber]
            .filter(Boolean)
            .join(" · "),
          amount: t.amount,
          currency: t.currency,
          category: t.classification?.label ?? "其他",
          categoryId: t.classification?.categoryId ?? "other",
          classificationPattern: t.counterparty ?? t.description,
          transactionId: t.id,
          invoiceId: matchedInvoice?.id,
          invoiceAmount: matchedInvoice?.amount,
          excludedFromCalculation: t.excludedFromCalculation,
          status: t.status,
        };
      }),
      ...($invoices.data ?? [])
        .filter((i) => !invoiceMatches.invoiceToTransactionId.has(i.id))
        .map((i) => ({
          id: i.id,
          source: "invoice" as const,
          date: i.invoiceDate,
          title: i.sellerName ?? "電子發票",
          subtitle: i.invoiceNumber ?? "",
          amount: i.amount,
          currency: "TWD",
          category: "發票",
          invoiceId: i.id,
          invoiceAmount: i.amount,
          status: "已開立",
        })),
      ...($trades.data ?? []).map((t) => ({
        id: t.id,
        source: "investment" as const,
        date: normalizeFinancialDate(t.tradeDate ?? t.postedDate),
        title: t.name ?? t.symbol ?? "投資交易",
        subtitle: [
          t.transactionName ?? t.transactionCode,
          t.quantity != null ? `${formatNumber(t.quantity)} 股` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        amount: t.price === 1 ? undefined : t.amount,
        currency: t.currency,
        category: "投資",
        status: "已完成",
      })),
    ].sort((a, b) => b.date.localeCompare(a.date)),
  );
  const detailItem = $derived(
    rawItems.find((item) => activityKey(item) === detailKey),
  );
  const detailInvoiceId = $derived(detailItem?.invoiceId ?? null);
  const detailInvoice = createQuery(
    toStore(() => invoiceDetailQuery(() => api, detailInvoiceId)),
  );
  const cashFlowMonths = recentMonthKeys(6);
  const months = [...cashFlowMonths].reverse();
  const monthlyCalculatedItems = $derived(
    rawItems.filter(
      (item) =>
        item.date.startsWith(selectedMonth) &&
        (item.source === "bank" ||
          item.source === "card" ||
          item.source === "invoice"),
    ),
  );
  const incomeSlices = $derived(
    buildActivityCategorySlices(monthlyCalculatedItems, "income", rateValues),
  );
  const expenseSlices = $derived(
    buildActivityCategorySlices(monthlyCalculatedItems, "expense", rateValues),
  );
  const incomeTotal = $derived(
    incomeSlices.reduce((sum, slice) => sum + slice.amount, 0),
  );
  const expenseTotal = $derived(
    expenseSlices.reduce((sum, slice) => sum + slice.amount, 0),
  );
  const currentMonth = new Date().toISOString().slice(0, 7);
  const selectedMonthLabel = $derived(`${Number(selectedMonth.slice(5))} 月`);
  const pendingCount = $derived(
    rawItems.filter(
      (item) =>
        (item.source === "bank" || item.source === "card") &&
        (item.status === "pending" || item.categoryId === "other"),
    ).length,
  );
  const cashFlow = $derived(
    cashFlowMonths.map((month) => {
      const items = rawItems.filter(
        (item) =>
          item.date.startsWith(month) &&
          (item.source === "bank" ||
            item.source === "card" ||
            item.source === "invoice"),
      );
      return {
        month,
        income: items.reduce(
          (sum, item) =>
            sum + Math.max(activityCashAmountTwd(item, rateValues), 0),
          0,
        ),
        expense: Math.abs(
          items.reduce(
            (sum, item) =>
              sum + Math.min(activityCashAmountTwd(item, rateValues), 0),
            0,
          ),
        ),
      };
    }),
  );
  const maxCashFlow = $derived(
    Math.max(...cashFlow.flatMap((point) => [point.income, point.expense]), 1),
  );
  const filtered = $derived(
    rawItems.filter((item) => {
      const matchesFlow =
        !selectedCategory || activityCashFlow(item) === selectedCategory.flow;
      const matchesSource =
        source === "all" ||
        item.source === source ||
        (source === "invoice" && Boolean(item.invoiceId));
      return (
        matchesSource &&
        item.date.startsWith(selectedMonth) &&
        (!search.trim() ||
          `${item.title} ${item.subtitle} ${item.category}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        (!selectedCategory ||
          (item.category === selectedCategory.category && matchesFlow))
      );
    }),
  );
  const mappingCandidates = $derived.by(() => {
    if (!mappingDialog) return [];
    const unavailableTransactionIds = new Set(
      Array.from(invoiceMatches.transactionToInvoice.entries())
        .filter(([, invoice]) => invoice.id !== mappingDialog!.invoice.id)
        .map(([transactionId]) => transactionId),
    );
    return invoiceTransactionCandidates(
      activityBankTransactions,
      mappingDialog.invoice,
      unavailableTransactionIds,
    );
  });
  const categoryMutation = createMutation({
    mutationFn: async (payload: {
      transactionId: string;
      categoryId: string;
      addRule: boolean;
      pattern: string;
      operator: "contains" | "equals";
    }) => {
      await api.put(
        `/api/classification/overrides/bank_transaction/${payload.transactionId}`,
        { categoryId: payload.categoryId },
      );
      if (payload.addRule)
        await api.post("/api/classification/rules", {
          categoryId: payload.categoryId,
          targetType: "bank_transaction",
          field: "any_text",
          operator: payload.operator,
          pattern: payload.pattern.trim(),
          priority: 200,
          description: "由活動頁建立",
        });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.bank });
      qc.invalidateQueries({ queryKey: queryKeys.classificationRules });
      pending = null;
    },
  });
  const calculationMutation = createMutation({
    mutationFn: (payload: {
      transactionId: string;
      excludedFromCalculation: boolean;
    }) =>
      api.patch(
        `/api/bank/transactions/${encodeURIComponent(payload.transactionId)}/calculation`,
        { excludedFromCalculation: payload.excludedFromCalculation },
      ),
    onSuccess: (_result, payload) => {
      qc.setQueryData<BankData>(queryKeys.bank, (current) =>
        current
          ? {
              ...current,
              transactions: current.transactions.map((transaction) =>
                transaction.id === payload.transactionId
                  ? {
                      ...transaction,
                      excludedFromCalculation: payload.excludedFromCalculation,
                    }
                  : transaction,
              ),
            }
          : current,
      );
      qc.invalidateQueries({ queryKey: queryKeys.bank });
    },
  });
  const mappingMutation = createMutation({
    mutationFn: (payload: { invoiceId: string; transactionId: string }) =>
      api.put<InvoiceTransactionPreference>(
        `/api/activity/invoice-mappings/${encodeURIComponent(payload.invoiceId)}`,
        { transactionId: payload.transactionId },
      ),
    onSuccess: (preference) => {
      updateMappingPreference(preference);
      mappingDialog = null;
      detailKey = null;
      showMappingNotice("已完成配對，活動只顯示一筆");
    },
  });
  const separationMutation = createMutation({
    mutationFn: (invoiceId: string) =>
      api.delete<InvoiceTransactionPreference>(
        `/api/activity/invoice-mappings/${encodeURIComponent(invoiceId)}`,
      ),
    onSuccess: (preference) => {
      updateMappingPreference(preference);
      mappingDialog = null;
      detailKey = null;
      showMappingNotice("已解除配對，兩筆活動將保持分開");
    },
  });
  function openCategory(item: ActivityItem, categoryId: string) {
    if (item.transactionId && categoryId !== item.categoryId)
      pending = {
        item,
        categoryId,
        addRule: false,
        pattern: item.classificationPattern ?? item.title,
        operator: "contains",
      };
  }
  function chooseCategory(flow: "income" | "expense", category: string) {
    selectedCategory =
      selectedCategory?.flow === flow && selectedCategory.category === category
        ? null
        : { flow, category };
  }
  function chooseMonth(month: string) {
    selectedMonth = month;
    selectedCategory = null;
  }
  function sourceLabel(item: ActivityItem) {
    const label = {
      bank: "銀行",
      card: "信用卡",
      investment: "投資",
      invoice: "發票",
    }[item.source];
    return item.source !== "invoice" && item.invoiceId
      ? `${label}＋發票`
      : label;
  }
  function activityKey(item: ActivityItem) {
    return `${item.source}-${item.id}`;
  }
  function openDetail(item: ActivityItem) {
    detailKey = activityKey(item);
  }
  function transactionForItem(item: ActivityItem) {
    return activityBankTransactions.find(
      (transaction) => transaction.id === item.transactionId,
    );
  }
  function toggleCalculation(item: ActivityItem) {
    if (!item.transactionId) return;
    $calculationMutation.mutate({
      transactionId: item.transactionId,
      excludedFromCalculation: !item.excludedFromCalculation,
    });
  }
  function updateMappingPreference(preference: InvoiceTransactionPreference) {
    qc.setQueryData<InvoiceTransactionPreference[]>(
      queryKeys.invoiceTransactionMappings,
      (current = []) => [
        preference,
        ...current.filter((row) => row.invoiceId !== preference.invoiceId),
      ],
    );
    qc.invalidateQueries({ queryKey: queryKeys.invoiceTransactionMappings });
  }
  function showMappingNotice(message: string) {
    mappingNotice = message;
    window.setTimeout(() => {
      if (mappingNotice === message) mappingNotice = "";
    }, 3500);
  }
  function invoiceForItem(item: ActivityItem) {
    return ($invoices.data ?? []).find(
      (invoice) => invoice.id === item.invoiceId,
    );
  }
  function openMapping(item: ActivityItem) {
    const invoice = invoiceForItem(item);
    if (!invoice) return;
    mappingDialog = {
      invoice,
      step: item.transactionId ? "actions" : "candidates",
      transactionId: item.transactionId,
    };
  }
  function chooseMappingTransaction(transactionId: string) {
    if (!mappingDialog) return;
    mappingDialog.transactionId = transactionId;
  }
  function selectedMappingTransaction(): BankTransactionRow | undefined {
    if (!mappingDialog?.transactionId) return undefined;
    return activityBankTransactions.find(
      (transaction) => transaction.id === mappingDialog?.transactionId,
    );
  }
  function mappingMerchant(transaction: BankTransactionRow) {
    return transaction.counterparty ?? transaction.description ?? "銀行交易";
  }
  function mappingAccount(transaction: BankTransactionRow) {
    return (
      transaction.institutionName ??
      transaction.accountName ??
      bankAccounts.get(transaction.accountId)?.institutionName ??
      "銀行／信用卡"
    );
  }
  function mappingDifference(
    invoice: InvoiceSummaryRow,
    transaction: BankTransactionRow,
  ) {
    return Math.abs(invoice.amount - Math.abs(transaction.amount));
  }
  function itemMappingDifference(item: ActivityItem) {
    if (item.invoiceAmount == null || item.amount == null) return 0;
    return Math.abs(item.invoiceAmount - Math.abs(item.amount));
  }
  function countMatches() {
    if (!pending) return 0;
    return activityBankTransactions.filter((t) =>
      `${t.description ?? ""} ${t.counterparty ?? ""}`
        .toLowerCase()
        .includes(pending!.pattern.toLowerCase()),
    ).length;
  }
</script>

{#if $bank.isPending || $invoices.isPending || $invoiceMappings.isPending || $trades.isPending}<EmptyState
    title="載入活動中"
    body="正在整理銀行、投資與發票資料。"
  />{:else}
  <div class="grid min-w-0 max-w-full gap-5 overflow-x-clip">
    <div
      class="hidden min-w-0 grid-cols-2 gap-3 md:grid md:grid-cols-4 md:gap-4"
    >
      <Card
        ><CardContent class="p-5"
          ><p class="text-xs font-semibold text-ink/50">
            {selectedMonthLabel}收入
          </p>
          <p class="mt-2 truncate text-2xl font-bold text-moss">
            +{formatCurrency(incomeTotal)}
          </p>
          <p class="mt-1 text-xs text-ink/45">銀行與信用卡活動</p></CardContent
        ></Card
      >
      <Card
        ><CardContent class="p-5"
          ><p class="text-xs font-semibold text-ink/50">
            {selectedMonthLabel}支出
          </p>
          <p class="mt-2 truncate text-2xl font-bold text-coral">
            −{formatCurrency(expenseTotal)}
          </p>
          <p class="mt-1 text-xs text-ink/45">
            含未配對發票，不計入已排除活動
          </p></CardContent
        ></Card
      >
      <Card
        ><CardContent class="p-5"
          ><p class="text-xs font-semibold text-ink/50">
            {selectedMonthLabel}淨流入
          </p>
          <p
            class={`mt-2 truncate text-2xl font-bold ${incomeTotal >= expenseTotal ? "text-moss" : "text-coral"}`}
          >
            {formatCurrency(incomeTotal - expenseTotal)}
          </p>
          <p class="mt-1 text-xs text-ink/45">收入 − 支出</p></CardContent
        ></Card
      >
      <Card
        ><CardContent class="p-5"
          ><p class="text-xs font-semibold text-ink/50">待分類</p>
          <p class="mt-2 text-2xl font-bold">{pendingCount} 筆</p>
          <p class="mt-1 text-xs text-ink/45">銀行交易</p></CardContent
        ></Card
      >
    </div>

    <section class="grid min-w-0 gap-3">
      <div
        class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="min-w-0">
          <h2 class="text-lg font-semibold">每月分類比例</h2>
          <p class="mt-1 text-xs text-ink/45">
            未配對發票列為支出，已配對發票不重複計算
          </p>
        </div>
        <Select
          aria-label="選擇活動月份"
          class="h-11 w-full min-w-0 font-semibold sm:w-auto sm:shrink-0"
          value={selectedMonth}
          onchange={(event: Event) =>
            chooseMonth((event.currentTarget as HTMLSelectElement).value)}
          >{#each months as month (month)}<option value={month}
              >{month.slice(0, 4)} 年 {Number(month.slice(5))} 月</option
            >{/each}</Select
        >
      </div>
      <div class="grid min-w-0 gap-3 lg:grid-cols-2">
        <ActivityCategoryChart
          flow="income"
          slices={incomeSlices}
          selectedCategory={selectedCategory?.flow === "income"
            ? selectedCategory.category
            : undefined}
          onSelect={(category) => chooseCategory("income", category)}
        />
        <ActivityCategoryChart
          flow="expense"
          slices={expenseSlices}
          selectedCategory={selectedCategory?.flow === "expense"
            ? selectedCategory.category
            : undefined}
          onSelect={(category) => chooseCategory("expense", category)}
        />
      </div>
    </section>

    <Card class="hidden md:block">
      <CardHeader class="flex-row items-center justify-between"
        ><h2 class="text-lg font-semibold">現金流趨勢</h2>
        <Badge variant="secondary">6 個月　收入／支出</Badge></CardHeader
      >
      <CardContent>
        <div class="grid grid-cols-6 gap-3">
          {#each cashFlow as point (point.month)}
            <button
              aria-pressed={selectedMonth === point.month}
              class={`grid min-w-0 rounded-xl px-2 pb-2 pt-3 transition ${selectedMonth === point.month ? "bg-steel/10 ring-2 ring-steel/30" : "hover:bg-paper"}`}
              onclick={() => chooseMonth(point.month)}
            >
              <div class="flex h-28 items-end justify-center gap-2">
                <span
                  class="w-1/3 rounded-t-lg bg-emerald-700"
                  style={`height:${Math.max(8, (point.income / maxCashFlow) * 100)}%`}
                ></span><span
                  class="w-1/3 rounded-t-lg bg-coral"
                  style={`height:${Math.max(8, (point.expense / maxCashFlow) * 100)}%`}
                ></span>
              </div>
              <span class="mt-2 text-xs font-semibold"
                >{Number(point.month.slice(5))} 月</span
              ><span class="mt-1 truncate text-[10px] text-moss"
                >+{formatCompactTwd(point.income)}</span
              ><span class="truncate text-[10px] text-coral"
                >−{formatCompactTwd(point.expense)}</span
              >
            </button>
          {/each}
        </div>
        <div class="mt-3 flex items-center justify-between text-xs text-ink/45">
          <span
            ><span class="text-emerald-700">■</span> 收入　<span
              class="text-coral">■</span
            > 支出</span
          ><button
            class="font-semibold text-steel"
            onclick={() => chooseMonth(currentMonth)}>回到本月</button
          >
        </div>
      </CardContent>
    </Card>

    <Card class="min-w-0 max-w-full overflow-hidden">
      <CardHeader class="min-w-0 gap-3 border-b border-ink/8">
        <div
          class="flex min-w-0 flex-col gap-3 md:flex-row md:items-center md:justify-between"
        >
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold">
              {selectedCategory
                ? `${selectedMonthLabel} · ${selectedCategory.category}`
                : `${selectedMonthLabel}所有活動`}
            </h2>
            <p class="text-xs text-ink/45">銀行、信用卡、投資與發票</p>
          </div>
          <div class="relative md:w-80">
            <Search
              class="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
            /><Input
              class="h-11 pl-9"
              placeholder="搜尋商家、帳戶、品項或分類"
              bind:value={search}
            />
          </div>
        </div>
        {#if selectedCategory}<div
            class="flex items-center justify-between rounded-lg bg-steel/10 px-3 py-2 text-sm"
          >
            <span
              ><strong>{selectedCategory.category}</strong> · {selectedCategory.flow ===
              "income"
                ? "收入"
                : "支出"}</span
            ><button
              class="min-h-8 px-2 text-xs font-semibold text-steel"
              onclick={() => (selectedCategory = null)}>顯示全部</button
            >
          </div>{/if}
        <TabsList class="grid h-auto w-full grid-cols-4"
          >{#each [{ key: "all", label: "全部" }, { key: "bank", label: "銀行" }, { key: "card", label: "信用卡" }, { key: "invoice", label: "發票" }] as filter (filter.key)}<TabsTrigger
              class={`min-h-9 min-w-0 px-1 text-xs md:text-sm ${source === filter.key ? "bg-ink text-white" : ""}`}
              active={source === filter.key}
              onclick={() => {
                source = filter.key as typeof source;
                selectedCategory = null;
              }}>{filter.label}</TabsTrigger
            >{/each}</TabsList
        >
        {#if $calculationMutation.isError}<p
            class="text-sm font-medium text-coral"
          >
            無法更新計算設定，請稍後再試。
          </p>{/if}
      </CardHeader>
      <CardContent class="min-w-0 p-0">
        <div class="min-w-0 divide-y divide-ink/8 md:hidden">
          {#if filtered.length === 0}<p
              class="p-8 text-center text-sm text-ink/50"
            >
              沒有符合條件的活動。
            </p>{:else}{#each filtered as item (item.source + "-" + item.id)}{@const amount =
                activityDisplayAmount(item)}
              <button
                aria-label={`查看 ${item.title} 活動詳情`}
                class={`flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition hover:bg-paper ${item.excludedFromCalculation ? "bg-ink/[0.025]" : ""}`}
                onclick={() => openDetail(item)}
              >
                <span
                  class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-steel/10 text-steel"
                  >{#if item.source === "bank"}<Building2
                      class="size-5"
                    />{:else if item.source === "card"}<CreditCard
                      class="size-5"
                    />{:else if item.source === "invoice"}<FileText
                      class="size-5"
                    />{:else}<TrendingUp class="size-5" />{/if}</span
                >
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-semibold">{item.title}</p>
                  <p class="mt-0.5 truncate text-xs text-ink/45">
                    {sourceLabel(item)} · {formatDate(item.date)}
                  </p>
                  <Badge variant="secondary" class="mt-1.5"
                    >{item.category}</Badge
                  >
                </div>
                <span class="flex shrink-0 items-center gap-1">
                  <span
                    class={`max-w-[38vw] truncate text-sm font-semibold tabular-nums ${item.excludedFromCalculation ? "text-ink/35 line-through" : (amount ?? 0) < 0 ? "text-coral" : item.source !== "invoice" ? "text-moss" : ""}`}
                  >
                    {amount == null
                      ? "—"
                      : `${amount >= 0 && item.source !== "invoice" ? "+" : ""}${formatCurrency(amount, item.currency)}`}
                  </span>
                  <ChevronRight class="size-4 text-ink/30" />
                </span>
              </button>{/each}{/if}
        </div>
        <div class="hidden overflow-x-auto md:block">
          <table class="w-full min-w-[760px] text-left text-sm">
            <thead class="bg-paper text-xs font-semibold text-ink/45"
              ><tr
                ><th class="px-5 py-3">日期</th><th class="px-4 py-3">來源</th
                ><th class="px-4 py-3">說明／商家</th><th class="px-4 py-3"
                  >分類</th
                ><th class="px-5 py-3 text-right">金額</th></tr
              ></thead
            ><tbody class="divide-y divide-ink/8"
              >{#if filtered.length === 0}<tr
                  ><td class="px-5 py-8 text-center text-ink/50" colspan="5"
                    >沒有符合條件的活動。</td
                  ></tr
                >{:else}{#each filtered as item (item.source + "-" + item.id)}{@const amount =
                    activityDisplayAmount(item)}<tr
                    aria-label={`查看 ${item.title} 活動詳情`}
                    class={`cursor-pointer transition hover:bg-paper focus-visible:outline-2 focus-visible:outline-steel ${item.excludedFromCalculation ? "bg-ink/[0.025]" : ""}`}
                    onclick={() => openDetail(item)}
                    onkeydown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openDetail(item);
                      }
                    }}
                    role="button"
                    tabindex="0"
                    ><td class="whitespace-nowrap px-5 py-3 text-ink/55"
                      >{formatDate(item.date)}</td
                    ><td class="px-4 py-3">{sourceLabel(item)}</td><td
                      class="max-w-xs px-4 py-3"
                      ><p class="truncate font-semibold">{item.title}</p>
                      <p class="truncate text-xs text-ink/40">
                        {item.subtitle}
                      </p>
                      {#if item.transactionId && item.invoiceId && itemMappingDifference(item) > 0}<Badge
                          variant="secondary"
                          class="mt-1 bg-amber-50 text-amber-800"
                          >點數折抵 {formatCurrency(
                            itemMappingDifference(item),
                          )}</Badge
                        >{/if}</td
                    ><td class="px-4 py-3"
                      ><Badge variant="secondary">{item.category}</Badge></td
                    ><td
                      class={`whitespace-nowrap px-5 py-3 text-right font-semibold tabular-nums ${item.excludedFromCalculation ? "text-ink/35 line-through" : (amount ?? 0) < 0 ? "text-coral" : item.source !== "invoice" ? "text-moss" : ""}`}
                      ><span class="inline-flex items-center gap-2"
                        >{amount == null
                          ? "—"
                          : formatCurrency(amount, item.currency)}<ChevronRight
                          class="size-4 text-ink/30"
                        /></span
                      ></td
                    ></tr
                  >{/each}{/if}</tbody
            >
          </table>
        </div>
      </CardContent>
    </Card>
    <div class="flex justify-end">
      <Button variant="ghost" onclick={() => navigate("invoices")}
        >查看完整發票明細 →</Button
      >
    </div>
    {#if detailItem}
      {@const amount = activityDisplayAmount(detailItem)}
      {@const transaction = transactionForItem(detailItem)}
      {@const invoice = invoiceForItem(detailItem)}
      <div class="fixed inset-0 z-[60] bg-ink/40 md:flex md:justify-end">
        <button
          aria-label="關閉活動明細"
          class="absolute inset-0 hidden md:block"
          onclick={() => (detailKey = null)}
        ></button>
        <div
          aria-labelledby="activity-detail-title"
          aria-modal="true"
          class="relative flex h-full w-full flex-col overflow-hidden bg-white shadow-2xl md:max-w-[32rem]"
          role="dialog"
          use:swipeBack={{
            enabled:
              document.documentElement.classList.contains("is-standalone"),
            onBack: () => (detailKey = null),
          }}
        >
          <header
            class="flex shrink-0 items-center justify-between border-b border-ink/10 px-4 py-3 md:px-6"
          >
            <div class="flex min-w-0 items-center gap-2">
              <button
                aria-label="返回活動列表"
                class="flex size-11 shrink-0 items-center justify-center rounded-full text-ink/60 hover:bg-paper"
                onclick={() => (detailKey = null)}
                ><ArrowLeft class="size-5 md:hidden" /><X
                  class="hidden size-5 md:block"
                /></button
              >
              <h2
                class="truncate text-lg font-semibold"
                id="activity-detail-title"
              >
                活動明細
              </h2>
            </div>
            <span class="text-xs font-medium text-ink/45"
              >{sourceLabel(detailItem)}</span
            >
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-7 md:py-6">
            <section class="border-b border-ink/10 pb-5">
              <div class="flex items-start justify-between gap-4">
                <div class="min-w-0">
                  <h3 class="break-words text-xl font-semibold leading-snug">
                    {detailItem.title}
                  </h3>
                  <p class="mt-1 text-sm text-ink/50">
                    {formatDate(detailItem.date)}{#if transaction}
                      · {mappingAccount(transaction)}
                    {/if}
                  </p>
                </div>
                <p
                  class={`shrink-0 pt-1 text-lg font-bold tabular-nums ${detailItem.excludedFromCalculation ? "text-ink/35 line-through" : (amount ?? 0) < 0 ? "text-coral" : detailItem.source !== "invoice" ? "text-moss" : ""}`}
                >
                  {amount == null
                    ? "—"
                    : `${amount >= 0 && detailItem.source !== "invoice" ? "+" : ""}${formatCurrency(amount, detailItem.currency)}`}
                </p>
              </div>
              <Badge variant="secondary" class="mt-3"
                >{detailItem.category}</Badge
              >
              {#if detailItem.excludedFromCalculation}<Badge
                  variant="secondary"
                  class="ml-2 mt-3">已排除計算</Badge
                >{/if}
              {#if transaction && invoice && itemMappingDifference(detailItem) > 0}<Badge
                  variant="secondary"
                  class="ml-2 mt-3 bg-amber-50 text-amber-800"
                  >點數折抵 {formatCurrency(
                    itemMappingDifference(detailItem),
                  )}</Badge
                >{/if}
            </section>

            <section class="border-b border-ink/10 py-5">
              <h3 class="text-base font-semibold">來源名稱</h3>
              <div class="mt-3 grid gap-3">
                {#if transaction}<div class="rounded-xl bg-steel/10 p-4">
                    <p class="text-xs font-semibold text-steel">
                      銀行／信用卡原始名稱
                    </p>
                    <p class="mt-1 break-words font-semibold">
                      {mappingMerchant(transaction)}
                    </p>
                    {#if transaction.description && transaction.description !== mappingMerchant(transaction)}<p
                        class="mt-1 break-words text-xs text-ink/50"
                      >
                        {transaction.description}
                      </p>{/if}
                    <p class="mt-1 text-xs text-ink/50">
                      {mappingAccount(transaction)} · 實付 {formatCurrency(
                        Math.abs(transaction.amount),
                        transaction.currency,
                      )}
                    </p>
                  </div>{/if}
                {#if invoice}<div class="rounded-xl bg-coral/10 p-4">
                    <p class="text-xs font-semibold text-coral">發票商家名稱</p>
                    <p class="mt-1 break-words font-semibold">
                      {invoice.sellerName ?? "電子發票"}
                    </p>
                    <p class="mt-1 text-xs text-ink/50">
                      發票 {invoice.invoiceNumber ?? "無發票號碼"} · 總額
                      {formatCurrency(invoice.amount)}
                    </p>
                  </div>{/if}
                {#if !transaction && invoice}<div
                    class="rounded-xl bg-amber-50 p-4 text-amber-900"
                  >
                    <p class="font-semibold">尚未找到銀行／信用卡交易</p>
                    <p class="mt-1 text-xs text-ink/55">
                      仍會列入當月支出；你可以在下方手動配對。
                    </p>
                  </div>{/if}
                {#if !transaction && !invoice}<div
                    class="rounded-xl bg-paper p-4"
                  >
                    <p class="text-xs font-semibold text-ink/50">來源說明</p>
                    <p class="mt-1 break-words font-semibold">
                      {detailItem.subtitle || detailItem.title}
                    </p>
                  </div>{/if}
              </div>
            </section>

            {#if invoice}<section class="border-b border-ink/10 py-5">
                <h3 class="text-base font-semibold">發票細項</h3>
                {#if $detailInvoice.isPending}<p
                    class="mt-3 rounded-xl bg-paper p-4 text-sm text-ink/50"
                  >
                    載入發票細項中。
                  </p>{:else if $detailInvoice.isError}<p
                    class="mt-3 rounded-xl bg-coral/10 p-4 text-sm text-coral"
                  >
                    無法載入發票細項，請稍後再試。
                  </p>{:else if !$detailInvoice.data || $detailInvoice.data.items.length === 0}<p
                    class="mt-3 rounded-xl bg-paper p-4 text-sm text-ink/50"
                  >
                    此發票沒有品項明細。
                  </p>{:else}<div class="mt-2 divide-y divide-ink/10">
                    {#each $detailInvoice.data.items as line (line.id)}<div
                        class="flex items-start justify-between gap-4 py-3"
                      >
                        <div class="min-w-0">
                          <p class="break-words font-medium">
                            {line.description}
                          </p>
                          <p class="mt-1 text-xs text-ink/50">
                            {line.quantity != null
                              ? `${formatNumber(line.quantity)} 件`
                              : "數量未提供"}{line.unitPrice != null
                              ? ` × ${formatCurrency(line.unitPrice)}`
                              : ""}
                          </p>
                        </div>
                        <p class="shrink-0 font-semibold tabular-nums">
                          {formatCurrency(line.amount)}
                        </p>
                      </div>{/each}
                  </div>{/if}
              </section>{/if}

            <section class="py-5">
              <h3 class="text-base font-semibold">活動設定</h3>
              <div class="mt-2 divide-y divide-ink/10">
                <div class="flex items-center justify-between gap-4 py-4">
                  <div>
                    <p class="font-semibold">分類</p>
                    {#if !detailItem.transactionId}<p
                        class="mt-1 text-xs text-ink/50"
                      >
                        {invoice
                          ? "配對銀行／信用卡交易後即可調整"
                          : "此來源目前不支援調整"}
                      </p>{/if}
                  </div>
                  {#if detailItem.transactionId}<Select
                      aria-label={`更新 ${detailItem.title} 分類`}
                      class="h-11 w-40 shrink-0 font-medium text-steel"
                      value={detailItem.categoryId}
                      onchange={(event: Event) =>
                        openCategory(
                          detailItem,
                          (event.currentTarget as HTMLSelectElement).value,
                        )}
                      >{#each categoryOptions as category (category.id)}<option
                          value={category.id}>{category.label}</option
                        >{/each}</Select
                    >{:else}<Badge variant="secondary"
                      >{detailItem.category}</Badge
                    >{/if}
                </div>

                {#if detailItem.transactionId}<label
                    class="flex cursor-pointer items-center justify-between gap-4 py-4"
                  >
                    <span>
                      <span class="block font-semibold">排除統計計算</span>
                      <span class="mt-1 block text-xs text-ink/50"
                        >保留活動，但不計入收支</span
                      >
                    </span>
                    <Checkbox
                      aria-label={`${detailItem.excludedFromCalculation ? "恢復" : "排除"} ${detailItem.title} 的統計計算`}
                      checked={detailItem.excludedFromCalculation}
                      disabled={$calculationMutation.isPending &&
                        $calculationMutation.variables?.transactionId ===
                          detailItem.transactionId}
                      onchange={() => toggleCalculation(detailItem)}
                    />
                  </label>{/if}

                {#if invoice}<div
                    class="flex items-center justify-between gap-4 py-4"
                  >
                    <div class="min-w-0">
                      <p class="font-semibold">發票配對</p>
                      <p
                        class={`mt-1 text-xs ${transaction ? "text-moss" : "text-coral"}`}
                      >
                        {transaction ? "已配對，可變更或解除" : "尚未配對"}
                      </p>
                    </div>
                    <Button
                      class="h-11 shrink-0 whitespace-nowrap"
                      variant={transaction ? "outline" : "default"}
                      onclick={() => openMapping(detailItem)}
                      >{transaction ? "管理配對" : "配對交易"}</Button
                    >
                  </div>{/if}
              </div>
            </section>
          </div>
        </div>
      </div>
    {/if}
    {#if pending}
      <CategoryUpdateDialog
        update={pending}
        {categories}
        matchCount={countMatches()}
        submitting={$categoryMutation.isPending}
        failed={$categoryMutation.isError}
        onCancel={() => (pending = null)}
        onSubmit={(input) => $categoryMutation.mutate(input)}
      />
    {/if}
    {#if mappingDialog}<div
        aria-modal="true"
        class="fixed inset-0 z-[75] flex items-end bg-ink/45 md:items-center md:justify-center md:p-6"
        role="dialog"
      >
        <div
          class="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl md:max-w-xl md:rounded-2xl md:p-6"
        >
          <div
            class="mx-auto mb-4 h-1.5 w-14 rounded-full bg-ink/20 md:hidden"
          ></div>
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <h2 class="text-xl font-semibold">
                {mappingDialog.step === "actions"
                  ? "管理配對"
                  : mappingDialog.step === "confirm"
                    ? "確認合併這兩筆？"
                    : "選擇同日候選交易"}
              </h2>
              {#if mappingDialog.step === "candidates"}<p
                  class="mt-1 truncate text-sm text-ink/50"
                >
                  發票：{mappingDialog.invoice.sellerName ?? "電子發票"} ·
                  {formatCurrency(mappingDialog.invoice.amount)}
                </p>{:else if mappingDialog.step === "confirm"}<p
                  class="mt-1 text-sm text-ink/50"
                >
                  合併後活動只顯示一筆，支出採銀行／信用卡實付金額。
                </p>{/if}
            </div>
            <button
              aria-label="關閉配對視窗"
              class="flex size-11 shrink-0 items-center justify-center rounded-full text-ink/50 hover:bg-paper"
              onclick={() => (mappingDialog = null)}
              ><X class="size-5" /></button
            >
          </div>

          {#if mappingDialog.step === "actions"}
            {@const transaction = selectedMappingTransaction()}
            {#if transaction}<div
                class="mt-5 rounded-xl border border-steel/30 bg-steel/5 p-4"
              >
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    <p class="truncate font-semibold">
                      {mappingDialog.invoice.sellerName ?? "電子發票"}
                    </p>
                    <p class="mt-1 truncate text-xs text-ink/50">
                      信用卡＋發票 · {mappingDialog.invoice.invoiceNumber ??
                        "無發票號碼"}
                    </p>
                  </div>
                  <p class="shrink-0 font-semibold text-coral">
                    {formatCurrency(-Math.abs(transaction.amount))}
                  </p>
                </div>
                {#if mappingDifference(mappingDialog.invoice, transaction) > 0}<Badge
                    variant="secondary"
                    class="mt-3 bg-amber-50 text-amber-800"
                    >點數折抵 {formatCurrency(
                      mappingDifference(mappingDialog.invoice, transaction),
                    )}</Badge
                  >{/if}
              </div>{/if}
            <div class="mt-5 grid gap-3">
              <Button
                class="h-12 justify-start gap-3"
                variant="outline"
                onclick={() => (mappingDialog!.step = "candidates")}
                ><Link2 class="size-4 text-steel" />變更配對</Button
              >
              <Button
                class="h-12 justify-start gap-3 text-coral"
                disabled={$separationMutation.isPending}
                variant="outline"
                onclick={() =>
                  $separationMutation.mutate(mappingDialog!.invoice.id)}
                ><Unlink2 class="size-4" />{$separationMutation.isPending
                  ? "解除中…"
                  : "解除並保持分開"}</Button
              >
            </div>
          {:else if mappingDialog.step === "candidates"}
            <div class="mt-5 grid max-h-[52vh] gap-3 overflow-y-auto pr-1">
              {#if mappingCandidates.length === 0}<div
                  class="rounded-xl border border-dashed border-ink/15 bg-paper p-6 text-center"
                >
                  <p class="font-semibold">同一天沒有可配對的支出</p>
                  <p class="mt-1 text-xs text-ink/50">
                    只有同一天的 TWD 銀行或信用卡支出會列在這裡。
                  </p>
                </div>{:else}{#each mappingCandidates as transaction (transaction.id)}{@const difference =
                    mappingDifference(
                      mappingDialog.invoice,
                      transaction,
                    )}<button
                    aria-pressed={mappingDialog.transactionId ===
                      transaction.id}
                    class={`min-h-24 rounded-xl border p-4 text-left transition ${mappingDialog.transactionId === transaction.id ? "border-steel bg-steel/10 ring-2 ring-steel/15" : "border-ink/10 hover:border-steel/40 hover:bg-paper"}`}
                    onclick={() => chooseMappingTransaction(transaction.id)}
                  >
                    <span class="flex items-start justify-between gap-3">
                      <span class="min-w-0">
                        <span class="block truncate font-semibold"
                          >{mappingMerchant(transaction)}</span
                        >
                        <span class="mt-1 block truncate text-xs text-ink/50"
                          >{mappingAccount(transaction)} · {formatDate(
                            transaction.authorizedAt ??
                              transaction.postedDate ??
                              "",
                          )}</span
                        >
                      </span>
                      <span class="shrink-0 font-semibold text-coral"
                        >{formatCurrency(-Math.abs(transaction.amount))}</span
                      >
                    </span>
                    <span class="mt-3 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" class="bg-moss/10 text-moss"
                        >同一天</Badge
                      >
                      {#if difference > 0}<Badge
                          variant="secondary"
                          class="bg-amber-50 text-amber-800"
                          >差額 {formatCurrency(difference)}</Badge
                        >{/if}
                    </span>
                  </button>{/each}{/if}
            </div>
            <p class="mt-4 text-xs text-ink/50">
              依同一天與金額接近排序；商家名稱可能因支付工具而不同，最後由你決定。
            </p>
            <div class="mt-5 grid grid-cols-[7rem_1fr] gap-3">
              <Button
                class="h-12"
                variant="secondary"
                onclick={() => (mappingDialog = null)}>取消</Button
              ><Button
                class="h-12"
                disabled={!mappingDialog.transactionId}
                onclick={() => (mappingDialog!.step = "confirm")}>下一步</Button
              >
            </div>
          {:else}
            {@const transaction = selectedMappingTransaction()}
            {#if transaction}{@const difference = mappingDifference(
                mappingDialog.invoice,
                transaction,
              )}
              <div class="mt-5 grid gap-3">
                <div class="rounded-xl bg-coral/10 p-4">
                  <p class="text-xs font-semibold text-coral">發票</p>
                  <div class="mt-2 flex items-center justify-between gap-4">
                    <p class="truncate font-semibold">
                      {mappingDialog.invoice.sellerName ?? "電子發票"}
                    </p>
                    <p class="shrink-0 font-semibold">
                      {formatCurrency(mappingDialog.invoice.amount)}
                    </p>
                  </div>
                </div>
                <ArrowDown class="mx-auto size-5 text-steel" />
                <div class="rounded-xl bg-steel/10 p-4">
                  <p class="text-xs font-semibold text-steel">銀行／信用卡</p>
                  <div class="mt-2 flex items-center justify-between gap-4">
                    <p class="truncate font-semibold">
                      {mappingMerchant(transaction)}
                    </p>
                    <p class="shrink-0 font-semibold">
                      {formatCurrency(Math.abs(transaction.amount))}
                    </p>
                  </div>
                </div>
                {#if difference > 0}<div
                    class="rounded-xl bg-amber-50 p-4 text-amber-900"
                  >
                    <p class="font-semibold">
                      差額 {formatCurrency(difference)}
                    </p>
                    <p class="mt-1 text-xs text-ink/55">
                      可能來自 LINE Pay 點數或其他折抵
                    </p>
                  </div>{/if}
                <p class="text-xs text-ink/50">
                  當月支出將計入 {formatCurrency(
                    Math.abs(transaction.amount),
                  )}，發票資料保留在合併紀錄中。
                </p>
              </div>
              <div class="mt-5 grid grid-cols-[7rem_1fr] gap-3">
                <Button
                  class="h-12"
                  variant="secondary"
                  onclick={() => (mappingDialog!.step = "candidates")}
                  >返回</Button
                ><Button
                  class="h-12"
                  disabled={$mappingMutation.isPending}
                  onclick={() =>
                    $mappingMutation.mutate({
                      invoiceId: mappingDialog!.invoice.id,
                      transactionId: transaction.id,
                    })}
                  >{$mappingMutation.isPending ? "配對中…" : "確認配對"}</Button
                >
              </div>
            {:else}<p class="mt-5 text-sm text-coral">
                找不到選取的交易，請返回重新選擇。
              </p>{/if}
          {/if}

          {#if $mappingMutation.isError || $separationMutation.isError}<p
              class="mt-4 text-sm font-medium text-coral"
            >
              無法更新配對，資料可能已變更，請重新整理後再試。
            </p>{/if}
        </div>
      </div>{/if}
    {#if mappingNotice}<div
        aria-live="polite"
        class="fixed left-1/2 top-20 z-[85] flex w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-white shadow-xl"
      >
        <Check class="size-5 shrink-0 text-lime-300" />{mappingNotice}
      </div>{/if}
  </div>
{/if}
