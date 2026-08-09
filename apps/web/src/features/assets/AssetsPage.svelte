<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import {
    Building2,
    ChevronRight,
    Landmark,
    WalletCards,
  } from "@lucide/svelte";
  import { exchangeRatesQuery, manualAssetsQuery } from "@/data/assets/queries";
  import { bankQuery, creditCardBillsQuery } from "@/data/bank/queries";
  import {
    investmentsQuery,
    investmentTransactionsQuery,
  } from "@/data/investments/queries";
  import type { ApiClient } from "@/shared/api/client";
  import { formatCurrency } from "@/shared/format/financial";
  import Card from "@/shared/ui/Card.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import EmptyState from "@/shared/ui/EmptyState.svelte";
  import InstitutionDetails from "./components/InstitutionDetails.svelte";
  import InvestmentWorkspace from "./components/InvestmentWorkspace.svelte";
  import ManualAssets from "./ManualAssets.svelte";
  import { calculateAssetSummary } from "./model/summary";
  import type { InstitutionAssetGroup } from "./model/summary";

  type LedgerItem =
    | {
        key: string;
        kind: "institution";
        label: string;
        group: InstitutionAssetGroup;
      }
    | { key: "investments"; kind: "investments"; label: "投資" }
    | { key: "manual-assets"; kind: "manual-assets"; label: "其他資產" };

  let { api }: { api: ApiClient } = $props();

  const bank = createQuery(bankQuery(() => api));
  const bills = createQuery(creditCardBillsQuery(() => api));
  const investments = createQuery(investmentsQuery(() => api));
  const trades = createQuery(investmentTransactionsQuery(() => api));
  const manual = createQuery(manualAssetsQuery(() => api));
  const rates = createQuery(exchangeRatesQuery(() => api));

  const summary = $derived(
    calculateAssetSummary({
      bank: $bank.data ?? { accounts: [], transactions: [] },
      investments: $investments.data ?? [],
      manualAssets: $manual.data ?? [],
      rates: $rates.data,
    }),
  );
  const loading = $derived(
    $bank.isPending ||
      $investments.isPending ||
      $manual.isPending ||
      $rates.isPending,
  );
  const failed = $derived(
    $bank.isError || $investments.isError || $manual.isError || $rates.isError,
  );
  const ledgerItems = $derived<LedgerItem[]>([
    ...summary.institutionGroups.map((group): LedgerItem => ({
      key: group.key,
      kind: "institution",
      label: group.institution,
      group,
    })),
    ...(($investments.data?.length ?? 0) > 0
      ? ([{ key: "investments", kind: "investments", label: "投資" }] as const)
      : []),
    ...(($manual.data?.length ?? 0) > 0
      ? ([
          {
            key: "manual-assets",
            kind: "manual-assets",
            label: "其他資產",
          },
        ] as const)
      : []),
  ]);

  let selectedKey = $state<string>();
  let expandedKey = $state<string | null>(null);
  const activeKey = $derived(
    selectedKey && ledgerItems.some((item) => item.key === selectedKey)
      ? selectedKey
      : ledgerItems[0]?.key,
  );
  const activeItem = $derived(
    ledgerItems.find((item) => item.key === activeKey),
  );
  const mobileExpandedKey = $derived(expandedKey);

  function toggleMobile(key: string) {
    expandedKey = mobileExpandedKey === key ? null : key;
  }
</script>

{#if loading}
  <EmptyState
    title="載入資產清冊中"
    body="正在彙整銀行、信用卡、投資與其他資產。"
  />
{:else if failed}
  <EmptyState
    title="無法載入資產清冊"
    body="部分必要資料目前無法取得，請稍後再試。"
  />
{:else}
  <div class="grid min-w-0 max-w-full gap-4">
    {#if summary.missingCurrencies.length > 0}
      <div
        class="rounded-xl border border-coral/25 bg-coral/5 px-4 py-3 text-sm text-ink"
        role="status"
      >
        <p class="font-semibold">部分外幣資產尚未納入新台幣總額</p>
        <p class="mt-1 text-xs text-ink/55">
          缺少 {summary.missingCurrencies.join("、")} 匯率；原始幣別金額仍會顯示在清冊中。
        </p>
      </div>
    {/if}

    <section
      class="grid grid-cols-2 gap-3 xl:grid-cols-[1.2fr_1fr_1fr_1fr]"
      aria-label="資產摘要"
    >
      <Card>
        <CardContent class="p-4">
          <p class="text-xs font-semibold text-ink/50">
            總資產｜不含信用卡負債
          </p>
          <p class="mt-2 text-xl font-bold tracking-tight tabular-nums">
            {formatCurrency(summary.grossAssets)}
          </p>
          <p class="mt-1 hidden text-xs text-ink/45 sm:block">
            銀行、投資與其他資產合計
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs font-semibold text-ink/50">銀行與現金</p>
          <p
            class="mt-2 text-xl font-bold tracking-tight tabular-nums text-steel"
          >
            {formatCurrency(summary.bankTotal)}
          </p>
          <p class="mt-1 text-xs text-ink/45">
            {summary.deposits.length} 個帳戶
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs font-semibold text-ink/50">投資</p>
          <p
            class="mt-2 text-xl font-bold tracking-tight tabular-nums text-steel"
          >
            {formatCurrency(summary.investmentTotal)}
          </p>
          <p class="mt-1 text-xs text-ink/45">
            {$investments.data?.length ?? 0} 個持倉
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs font-semibold text-ink/50">信用卡負債</p>
          <p
            class="mt-2 text-xl font-bold tracking-tight tabular-nums text-coral"
          >
            {formatCurrency(-summary.cardDebt)}
          </p>
          <p class="mt-1 text-xs text-ink/45">
            {summary.cards.length} 張卡片
          </p>
        </CardContent>
      </Card>
    </section>

    {#if ledgerItems.length === 0}
      <EmptyState
        title="尚無資產資料"
        body="完成資料來源同步，或新增一筆其他資產後即可在此查看。"
      />
    {:else}
      <section
        class="hidden h-[620px] min-w-0 grid-cols-[minmax(320px,0.9fr)_minmax(360px,1.1fr)] gap-4 xl:grid"
        aria-label="資產清冊"
      >
        <Card class="flex min-h-0 flex-col overflow-hidden">
          <header
            class="flex items-center justify-between gap-3 border-b border-border px-4 py-3"
          >
            <div>
              <h2 class="font-semibold">帳戶與資產</h2>
              <p class="mt-1 text-xs text-muted-foreground">
                同一金融機構的帳戶與信用卡合併顯示
              </p>
            </div>
            <span class="text-xs text-muted-foreground">
              {ledgerItems.length} 項
            </span>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto">
            {#if summary.institutionGroups.length > 0}
              <p
                class="bg-muted px-4 py-2 text-xs font-semibold text-muted-foreground"
              >
                金融機構
              </p>
              {#each summary.institutionGroups as group (group.key)}
                <button
                  class={`grid min-h-[68px] w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-2 text-left transition hover:bg-muted ${activeKey === group.key ? "bg-accent shadow-[inset_3px_0_0_hsl(var(--primary))]" : "bg-white"}`}
                  type="button"
                  aria-pressed={activeKey === group.key}
                  onclick={() => (selectedKey = group.key)}
                >
                  <span
                    class="flex size-9 items-center justify-center rounded-lg border border-border bg-paper text-xs font-bold text-steel"
                  >
                    {group.institution.slice(0, 1)}
                  </span>
                  <span class="min-w-0">
                    <strong class="block truncate text-sm">
                      {group.institution}
                    </strong>
                    <small class="mt-1 block truncate text-xs text-ink/45">
                      {group.accounts.length} 帳戶 · {group.cards.length} 卡片{group
                        .foreignCurrencies.length
                        ? ` · 含 ${group.foreignCurrencies.join("、")}`
                        : ""}
                    </small>
                  </span>
                  <span class="text-right">
                    <strong class="block text-sm tabular-nums text-steel">
                      {group.accounts.length
                        ? formatCurrency(group.assetTotalTwd)
                        : "—"}
                    </strong>
                    <small
                      class={`mt-1 block text-xs tabular-nums ${group.cards.length ? "text-coral" : "text-ink/40"}`}
                    >
                      {group.cards.length
                        ? `負債 ${formatCurrency(-group.debtTotalTwd)}`
                        : "無信用卡"}
                    </small>
                  </span>
                </button>
              {/each}
            {/if}

            {#if ($investments.data?.length ?? 0) > 0}
              <p
                class="bg-muted px-4 py-2 text-xs font-semibold text-muted-foreground"
              >
                投資
              </p>
              <button
                class={`grid min-h-[68px] w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-2 text-left transition hover:bg-muted ${activeKey === "investments" ? "bg-accent shadow-[inset_3px_0_0_hsl(var(--primary))]" : "bg-white"}`}
                type="button"
                aria-pressed={activeKey === "investments"}
                onclick={() => (selectedKey = "investments")}
              >
                <span
                  class="flex size-9 items-center justify-center rounded-lg border border-border bg-paper text-steel"
                  ><Landmark class="size-4" /></span
                >
                <span class="min-w-0">
                  <strong class="block text-sm">投資</strong>
                  <small class="mt-1 block text-xs text-ink/45">
                    {$investments.data?.length ?? 0} 個持倉 · 持倉與交易紀錄
                  </small>
                </span>
                <strong class="text-sm tabular-nums text-steel">
                  {formatCurrency(summary.investmentTotal)}
                </strong>
              </button>
            {/if}

            {#if ($manual.data?.length ?? 0) > 0}
              <p
                class="bg-muted px-4 py-2 text-xs font-semibold text-muted-foreground"
              >
                其他資產
              </p>
              <button
                class={`grid min-h-[68px] w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-2 text-left transition hover:bg-muted ${activeKey === "manual-assets" ? "bg-accent shadow-[inset_3px_0_0_hsl(var(--primary))]" : "bg-white"}`}
                type="button"
                aria-pressed={activeKey === "manual-assets"}
                onclick={() => (selectedKey = "manual-assets")}
              >
                <span
                  class="flex size-9 items-center justify-center rounded-lg border border-border bg-paper text-moss"
                  ><WalletCards class="size-4" /></span
                >
                <span class="min-w-0">
                  <strong class="block text-sm">其他資產</strong>
                  <small class="mt-1 block text-xs text-ink/45">
                    {$manual.data?.length ?? 0} 筆 · 手動維護估值
                  </small>
                </span>
                <strong class="text-sm tabular-nums text-moss">
                  {formatCurrency(summary.manualTotal)}
                </strong>
              </button>
            {/if}
          </div>
        </Card>

        <Card class="min-h-0 overflow-y-auto">
          {#if activeItem?.kind === "institution"}
            <InstitutionDetails
              group={activeItem.group}
              bills={$bills.data ?? []}
              billsPending={$bills.isPending}
              billsError={$bills.isError}
            />
          {:else if activeItem?.kind === "investments"}
            <InvestmentWorkspace
              positions={$investments.data ?? []}
              trades={$trades.data ?? []}
              total={summary.investmentTotal}
              tradesPending={$trades.isPending}
              tradesError={$trades.isError}
            />
          {:else if activeItem?.kind === "manual-assets"}
            <ManualAssets {api} variant="embedded" />
          {/if}
        </Card>
      </section>

      <section class="grid gap-3 xl:hidden" aria-label="資產清冊">
        {#if summary.institutionGroups.length > 0}
          <div class="flex items-center justify-between px-1 pt-1">
            <h2 class="text-base font-semibold">金融機構</h2>
            <span class="text-xs text-muted-foreground">
              {summary.institutionGroups.length} 個機構
            </span>
          </div>
          {#each summary.institutionGroups as group (group.key)}
            <Card class="overflow-hidden">
              <button
                class="grid min-h-[72px] w-full grid-cols-[36px_minmax(0,1fr)_auto_16px] items-center gap-3 px-3 py-2 text-left"
                type="button"
                aria-expanded={mobileExpandedKey === group.key}
                onclick={() => toggleMobile(group.key)}
              >
                <span
                  class="flex size-9 items-center justify-center rounded-lg border border-border bg-paper text-xs font-bold text-steel"
                >
                  {group.institution.slice(0, 1)}
                </span>
                <span class="min-w-0">
                  <strong class="block truncate text-sm">
                    {group.institution}
                  </strong>
                  <small class="mt-1 block truncate text-xs text-ink/45">
                    {group.accounts.length} 帳戶 · {group.cards.length} 卡片{group
                      .foreignCurrencies.length
                      ? ` · 含 ${group.foreignCurrencies.join("、")}`
                      : ""}
                  </small>
                </span>
                <span class="text-right">
                  <strong class="block text-sm tabular-nums text-steel">
                    {group.accounts.length
                      ? formatCurrency(group.assetTotalTwd)
                      : "—"}
                  </strong>
                  <small
                    class={`mt-1 block text-xs tabular-nums ${group.cards.length ? "text-coral" : "text-ink/40"}`}
                  >
                    {group.cards.length
                      ? `負債 ${formatCurrency(-group.debtTotalTwd)}`
                      : "無信用卡"}
                  </small>
                </span>
                <ChevronRight
                  class={`size-4 text-ink/40 transition ${mobileExpandedKey === group.key ? "rotate-90" : ""}`}
                />
              </button>
              {#if mobileExpandedKey === group.key}
                <div class="border-t border-border bg-paper/60 p-3">
                  <InstitutionDetails
                    {group}
                    bills={$bills.data ?? []}
                    billsPending={$bills.isPending}
                    billsError={$bills.isError}
                    compact
                  />
                </div>
              {/if}
            </Card>
          {/each}
        {/if}

        {#if ($investments.data?.length ?? 0) > 0}
          <div class="flex items-center justify-between px-1 pt-2">
            <h2 class="text-base font-semibold">投資</h2>
            <span class="text-xs text-muted-foreground">持倉與交易</span>
          </div>
          <Card class="overflow-hidden">
            <button
              class="grid min-h-[68px] w-full grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 px-4 text-left"
              type="button"
              aria-expanded={mobileExpandedKey === "investments"}
              onclick={() => toggleMobile("investments")}
            >
              <span>
                <strong class="block text-sm">投資組合</strong>
                <small class="mt-1 block text-xs text-ink/45">
                  {$investments.data?.length ?? 0} 個持倉 · 交易紀錄
                </small>
              </span>
              <strong class="text-sm tabular-nums text-steel">
                {formatCurrency(summary.investmentTotal)}
              </strong>
              <ChevronRight
                class={`size-4 text-ink/40 transition ${mobileExpandedKey === "investments" ? "rotate-90" : ""}`}
              />
            </button>
            {#if mobileExpandedKey === "investments"}
              <div class="border-t border-border p-3">
                <InvestmentWorkspace
                  positions={$investments.data ?? []}
                  trades={$trades.data ?? []}
                  total={summary.investmentTotal}
                  tradesPending={$trades.isPending}
                  tradesError={$trades.isError}
                  compact
                />
              </div>
            {/if}
          </Card>
        {/if}

        <div class="flex items-center justify-between px-1 pt-2">
          <h2 class="text-base font-semibold">其他資產</h2>
          <span class="text-xs text-muted-foreground">手動維護</span>
        </div>
        <Card class="overflow-hidden">
          <button
            class="grid min-h-[68px] w-full grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 px-4 text-left"
            type="button"
            aria-expanded={mobileExpandedKey === "manual-assets"}
            onclick={() => toggleMobile("manual-assets")}
          >
            <span>
              <strong class="block text-sm">其他資產</strong>
              <small class="mt-1 block text-xs text-ink/45">
                {$manual.data?.length ?? 0} 筆 · 估值歷史
              </small>
            </span>
            <strong class="text-sm tabular-nums text-moss">
              {formatCurrency(summary.manualTotal)}
            </strong>
            <ChevronRight
              class={`size-4 text-ink/40 transition ${mobileExpandedKey === "manual-assets" ? "rotate-90" : ""}`}
            />
          </button>
          {#if mobileExpandedKey === "manual-assets"}
            <div class="border-t border-border p-3">
              <ManualAssets {api} variant="embedded" />
            </div>
          {/if}
        </Card>
      </section>
    {/if}
  </div>
{/if}
