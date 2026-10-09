<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { ChevronRight } from "@lucide/svelte";
  import { exchangeRatesQuery, manualAssetsQuery } from "@/data/assets/queries";
  import { bankQuery, creditCardBillsQuery } from "@/data/bank/queries";
  import {
    investmentsQuery,
    investmentTransactionsQuery,
  } from "@/data/investments/queries";
  import type { ApiClient } from "@/shared/api/client";
  import { formatCompactTwd, formatCurrency } from "@/shared/format/financial";
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
  let otherAssets = $state<{ openAdd: () => void }>();
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
    alert
    title="無法載入資產清冊"
    body="部分必要資料目前無法取得，請稍後再試。"
  />
{:else}
  <div class="grid min-w-0 max-w-full gap-6">
    {#if summary.missingCurrencies.length > 0}
      <div
        class="rounded-xl border border-coral/25 bg-coral/5 px-4 py-3 text-sm text-ink"
        role="status"
      >
        <p class="font-semibold">部分外幣資產尚未納入新台幣總額</p>
        <p class="mt-1 text-caption text-subtle">
          缺少 {summary.missingCurrencies.join("、")} 匯率；原始幣別金額仍會顯示在清冊中。
        </p>
      </div>
    {/if}

    <section class="min-w-0 pt-3 md:pt-2" aria-label="淨資產">
      <div>
        <p class="text-sm text-subtle">淨資產</p>
        <p
          class="mt-3 break-all text-[clamp(2rem,7vw,2.75rem)] leading-tight font-semibold tracking-tight tabular-nums"
        >
          {formatCurrency(summary.netWorth)}
        </p>
        <div class="mt-3 grid gap-1 text-caption text-subtle">
          <p>
            {summary.hasUnknownCardBalance
              ? "信用卡負債資料不完整"
              : summary.cardDebt < 0
                ? `已計入 ${formatCurrency(-summary.cardDebt)} 信用卡溢繳餘額`
                : `已扣除 ${formatCurrency(summary.cardDebt)} 信用卡負債`}
          </p>
          <p>
            {summary.hasUnknownLoanBalance
              ? "貸款負債資料不完整"
              : `已扣除 ${formatCurrency(summary.loanDebt)} 貸款負債`}
          </p>
        </div>
      </div>
      <div class="mt-6 grid grid-cols-3 gap-3 md:gap-6">
        <div class="min-w-0">
          <p class="text-caption text-subtle">銀行與現金</p>
          <p
            class="mt-2 text-lg font-medium tracking-tight tabular-nums md:hidden"
          >
            {formatCompactTwd(summary.bankTotal)}
          </p>
          <p
            class="mt-2 hidden break-all text-2xl font-semibold tracking-tight tabular-nums md:block"
          >
            {formatCurrency(summary.bankTotal)}
          </p>
          <p class="mt-1 text-caption text-subtle">
            {summary.deposits.length} 個帳戶
          </p>
        </div>
        <div class="min-w-0">
          <p class="text-caption text-subtle">投資</p>
          <p
            class="mt-2 text-lg font-medium tracking-tight tabular-nums md:hidden"
          >
            {formatCompactTwd(summary.investmentTotal)}
          </p>
          <p
            class="mt-2 hidden break-all text-2xl font-semibold tracking-tight tabular-nums md:block"
          >
            {formatCurrency(summary.investmentTotal)}
          </p>
          <p class="mt-1 text-caption text-subtle">
            {$investments.data?.length ?? 0} 個持倉
          </p>
        </div>
        <div class="min-w-0">
          <p class="text-caption text-subtle">其他資產</p>
          <p
            class="mt-2 text-lg font-medium tracking-tight tabular-nums md:hidden"
          >
            {formatCompactTwd(summary.manualTotal)}
          </p>
          <p
            class="mt-2 hidden break-all text-2xl font-semibold tracking-tight tabular-nums md:block"
          >
            {formatCurrency(summary.manualTotal)}
          </p>
          <p class="mt-1 text-caption text-subtle">
            {$manual.data?.length ?? 0} 筆
          </p>
        </div>
      </div>
    </section>

    {#if ledgerItems.length === 0}
      <EmptyState
        title="尚無資產資料"
        body="完成資料來源同步，或新增一筆其他資產後即可在此查看。"
      />
    {:else}
      <section
        class="hidden h-[620px] min-w-0 grid-cols-[minmax(320px,0.9fr)_minmax(360px,1.1fr)] border-t border-ink/10 xl:grid"
        aria-label="資產清冊"
      >
        <div
          class="flex min-h-0 flex-col overflow-hidden border-r border-ink/10"
        >
          <header
            class="flex items-center justify-between gap-3 border-b border-ink/10 px-3 py-4"
          >
            <div>
              <h2 class="font-semibold">帳戶與資產</h2>
              <p class="mt-1 text-caption text-subtle">
                同一金融機構的帳戶與信用卡合併顯示
              </p>
            </div>
            <span class="text-caption text-subtle">
              {ledgerItems.length} 項
            </span>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto">
            {#if summary.institutionGroups.length > 0}
              <p class="px-3 py-2 text-caption font-medium text-subtle">
                金融機構
              </p>
              {#each summary.institutionGroups as group (group.key)}
                <button
                  class={`grid min-h-[68px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-ink/8 px-3 py-2 text-left transition hover:bg-ink/3 ${activeKey === group.key ? "bg-ink/4 shadow-[inset_3px_0_0_var(--color-steel)]" : ""}`}
                  type="button"
                  aria-pressed={activeKey === group.key}
                  onclick={() => (selectedKey = group.key)}
                >
                  <span class="min-w-0">
                    <strong class="block truncate text-sm">
                      {group.institution}
                    </strong>
                    <small class="mt-1 block truncate text-caption text-subtle">
                      {group.accounts.length} 帳戶 · {group.loans.length} 貸款 · {group
                        .cards.length} 卡片{group.foreignCurrencies.length
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
                      class={`mt-1 block text-caption tabular-nums ${group.cards.length || group.loans.length ? "text-coral" : "text-subtle"}`}
                    >
                      {#if group.cards.length && group.loans.length}
                        {group.hasUnknownCardBalance
                          ? "信用卡資料不完整"
                          : `${group.debtTotalTwd < 0 ? "溢繳" : "卡債"} ${formatCurrency(-group.debtTotalTwd)}`}
                        · {group.hasUnknownLoanBalance
                          ? "貸款資料不完整"
                          : `貸款 ${formatCurrency(group.loanDebtTotalTwd)}`}
                      {:else if group.loans.length}
                        {group.hasUnknownLoanBalance
                          ? "貸款資料不完整"
                          : `貸款 ${formatCurrency(group.loanDebtTotalTwd)}`}
                      {:else if group.cards.length}
                        {group.hasUnknownCardBalance
                          ? "信用卡資料不完整"
                          : `${group.debtTotalTwd < 0 ? "溢繳" : "卡債"} ${formatCurrency(-group.debtTotalTwd)}`}
                      {:else}
                        無負債帳戶
                      {/if}
                    </small>
                  </span>
                </button>
              {/each}
            {/if}

            {#if ($investments.data?.length ?? 0) > 0}
              <button
                class={`grid min-h-[68px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-ink/8 px-3 py-2 text-left transition hover:bg-ink/3 ${activeKey === "investments" ? "bg-ink/4 shadow-[inset_3px_0_0_var(--color-steel)]" : ""}`}
                type="button"
                aria-pressed={activeKey === "investments"}
                onclick={() => (selectedKey = "investments")}
              >
                <span class="min-w-0">
                  <strong class="block text-sm">投資</strong>
                  <small class="mt-1 block text-caption text-subtle">
                    {$investments.data?.length ?? 0} 個持倉 · 持倉與交易紀錄
                  </small>
                </span>
                <strong class="text-sm tabular-nums text-steel">
                  {formatCurrency(summary.investmentTotal)}
                </strong>
              </button>
            {/if}

            {#if ($manual.data?.length ?? 0) > 0}
              <button
                class={`grid min-h-[68px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-ink/8 px-3 py-2 text-left transition hover:bg-ink/3 ${activeKey === "manual-assets" ? "bg-ink/4 shadow-[inset_3px_0_0_var(--color-steel)]" : ""}`}
                type="button"
                aria-pressed={activeKey === "manual-assets"}
                onclick={() => (selectedKey = "manual-assets")}
              >
                <span class="min-w-0">
                  <strong class="block text-sm">其他資產</strong>
                  <small class="mt-1 block text-caption text-subtle">
                    {$manual.data?.length ?? 0} 筆 · 手動維護估值
                  </small>
                </span>
                <strong class="text-sm tabular-nums text-moss">
                  {formatCurrency(summary.manualTotal)}
                </strong>
              </button>
            {/if}
          </div>
        </div>

        <div class="min-h-0 overflow-y-auto">
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
        </div>
      </section>

      <section
        class="grid border-t border-ink/10 pt-5 xl:hidden"
        aria-label="資產清冊"
      >
        {#if summary.institutionGroups.length > 0}
          <div class="flex items-start justify-between gap-3 pb-1">
            <div class="min-w-0">
              <h2 class="text-base font-semibold">金融機構</h2>
              <p class="mt-1 text-caption text-subtle">
                {summary.institutionGroups.length} 個機構
              </p>
            </div>
            <strong
              class="text-lg font-medium tracking-tight tabular-nums text-steel"
            >
              {formatCurrency(summary.bankTotal)}
            </strong>
          </div>
          {#each summary.institutionGroups as group (group.key)}
            <div
              class={mobileExpandedKey === group.key
                ? "border-b border-ink/15 last:border-b-0"
                : "border-b border-ink/8 last:border-b-0"}
            >
              <button
                class="grid min-h-[72px] w-full grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 py-2 text-left"
                type="button"
                aria-expanded={mobileExpandedKey === group.key}
                onclick={() => toggleMobile(group.key)}
              >
                <span class="min-w-0">
                  <strong class="block truncate text-sm">
                    {group.institution}
                  </strong>
                  <small class="mt-1 block truncate text-caption text-subtle">
                    {group.accounts.length} 帳戶 · {group.loans.length} 貸款 · {group
                      .cards.length} 卡片{group.foreignCurrencies.length
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
                    class={`mt-1 block text-caption tabular-nums ${group.cards.length || group.loans.length ? "text-coral" : "text-subtle"}`}
                  >
                    {#if group.cards.length && group.loans.length}
                      {group.hasUnknownCardBalance
                        ? "信用卡資料不完整"
                        : `${group.debtTotalTwd < 0 ? "溢繳" : "卡債"} ${formatCurrency(-group.debtTotalTwd)}`}
                      · {group.hasUnknownLoanBalance
                        ? "貸款資料不完整"
                        : `貸款 ${formatCurrency(group.loanDebtTotalTwd)}`}
                    {:else if group.loans.length}
                      {group.hasUnknownLoanBalance
                        ? "貸款資料不完整"
                        : `貸款 ${formatCurrency(group.loanDebtTotalTwd)}`}
                    {:else if group.cards.length}
                      {group.hasUnknownCardBalance
                        ? "信用卡資料不完整"
                        : `${group.debtTotalTwd < 0 ? "溢繳" : "卡債"} ${formatCurrency(-group.debtTotalTwd)}`}
                    {:else}
                      無負債帳戶
                    {/if}
                  </small>
                </span>
                <ChevronRight
                  class={`size-4 text-subtle transition ${mobileExpandedKey === group.key ? "rotate-90" : ""}`}
                />
              </button>
              {#if mobileExpandedKey === group.key}
                <div class="border-t border-ink/8 pb-5 pl-4 pt-3">
                  <InstitutionDetails
                    {group}
                    bills={$bills.data ?? []}
                    billsPending={$bills.isPending}
                    billsError={$bills.isError}
                    compact
                  />
                </div>
              {/if}
            </div>
          {/each}
        {/if}

        {#if ($investments.data?.length ?? 0) > 0}
          <div class="border-t border-ink/10 pt-5">
            <div class="flex items-start justify-between gap-3 pb-1">
              <div class="min-w-0">
                <h2 class="text-base font-semibold">投資</h2>
                <p class="mt-1 text-caption text-subtle">
                  {$investments.data?.length ?? 0} 個持倉 · 交易紀錄
                </p>
              </div>
              <strong
                class="text-lg font-medium tracking-tight tabular-nums text-steel"
              >
                {formatCurrency(summary.investmentTotal)}
              </strong>
            </div>
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

        <div class="border-t border-ink/10 pt-5">
          <div class="flex items-start justify-between gap-3 pb-1">
            <div class="min-w-0">
              <h2 class="text-base font-semibold">其他資產</h2>
              <p class="mt-1 text-caption text-subtle">
                {$manual.data?.length ?? 0} 筆 · 估值歷史
              </p>
            </div>
            <div class="shrink-0 text-right">
              <strong
                class="text-lg font-medium tracking-tight tabular-nums text-moss"
              >
                {formatCurrency(summary.manualTotal)}
              </strong>
              <button
                type="button"
                class="mt-1 block w-full text-sm font-medium text-steel hover:text-steel/80"
                onclick={() => otherAssets?.openAdd()}
              >
                新增資產
              </button>
            </div>
          </div>
          <ManualAssets
            bind:this={otherAssets}
            {api}
            variant="embedded"
            hideSummary={true}
          />
        </div>
      </section>
    {/if}
  </div>
{/if}
