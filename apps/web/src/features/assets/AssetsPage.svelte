<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { Building2, CreditCard } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import EmptyState from "@/shared/ui/EmptyState.svelte";
  import TabsList from "@/shared/ui/TabsList.svelte";
  import TabsTrigger from "@/shared/ui/TabsTrigger.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { exchangeRatesQuery, manualAssetsQuery } from "@/data/assets/queries";
  import { bankQuery } from "@/data/bank/queries";
  import { investmentsQuery } from "@/data/investments/queries";
  import type { View } from "@/app/types";
  import { calculateAssetSummary } from "./model/summary";
  import type { AssetSection } from "./model/types";
  import {
    formatBankAccountName,
    formatCurrency,
    formatDate,
    formatNumber,
  } from "@/shared/format/financial";

  let { api, navigate }: { api: ApiClient; navigate: (view: View) => void } =
    $props();
  const bank = createQuery(bankQuery(() => api));
  const investments = createQuery(investmentsQuery(() => api));
  const manual = createQuery(manualAssetsQuery(() => api));
  const rates = createQuery(exchangeRatesQuery(() => api));

  let section = $state<AssetSection>("all");
  const summary = $derived(
    calculateAssetSummary({
      bank: $bank.data ?? { accounts: [], transactions: [] },
      investments: $investments.data ?? [],
      manualAssets: $manual.data ?? [],
      rates: $rates.data,
    }),
  );
  const deposits = $derived(summary.deposits);
  const cards = $derived(summary.cards);
  const bankTotal = $derived(summary.bankTotal);
  const investmentTotal = $derived(summary.investmentTotal);
  const manualTotal = $derived(summary.manualTotal);
  const cardDebt = $derived(summary.cardDebt);
  const grossAssets = $derived(summary.grossAssets);
  const netWorth = $derived(summary.netWorth);
  const groupedBanks = $derived(summary.groupedBanks);
  const tabs: { key: AssetSection; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "bank", label: "銀行" },
    { key: "cards", label: "信用卡" },
    { key: "investments", label: "投資" },
    { key: "manual-assets", label: "其他資產" },
  ];
  const loading = $derived(
    $bank.isPending || $investments.isPending || $manual.isPending,
  );
  const failed = $derived(
    $bank.isError || $investments.isError || $manual.isError,
  );
  const mobileSummary = $derived(
    section === "bank"
      ? {
          label: "銀行與現金",
          value: bankTotal,
          detail: `${deposits.length} 個帳戶`,
        }
      : section === "cards"
        ? {
            label: "信用卡負債",
            value: cardDebt,
            detail: `${cards.length} 張卡片 · 目前未繳`,
          }
        : section === "investments"
          ? {
              label: "投資市值",
              value: investmentTotal,
              detail: `${$investments.data?.length ?? 0} 個持倉 · TDCC`,
            }
          : section === "manual-assets"
            ? {
                label: "其他資產",
                value: manualTotal,
                detail: "房產、保險與交通工具",
              }
            : {
                label: "全部資產",
                value: netWorth,
                detail: "淨資產 · 已扣除信用卡負債",
              },
  );
</script>

{#if loading}
  <EmptyState
    title="載入資產中"
    body="正在彙整銀行、信用卡、投資與其他資產。"
  />
{:else if failed}
  <EmptyState
    title="無法載入資產"
    body="請稍後再試，或確認 Worker API 是否可用。"
  />
{:else}
  <div class="grid min-w-0 max-w-full gap-5">
    <section class="rounded-2xl bg-ink p-5 text-white shadow-xs md:hidden">
      <p class="text-xs font-semibold tracking-wide text-white/60">
        {mobileSummary.label}
      </p>
      <p
        class="mt-2 break-words text-3xl font-bold tracking-tight tabular-nums"
      >
        {formatCurrency(mobileSummary.value)}
      </p>
      <p class="mt-2 text-xs text-white/60">{mobileSummary.detail}</p>
    </section>

    <div class="hidden gap-4 md:grid md:grid-cols-2 xl:grid-cols-4">
      {#each [{ label: "資產總額", value: grossAssets, detail: "不含信用卡負債", tone: "" }, { label: "銀行與現金", value: bankTotal, detail: `${deposits.length} 個帳戶`, tone: "text-moss" }, { label: "投資", value: investmentTotal, detail: `${$investments.data?.length ?? 0} 個持倉`, tone: "text-steel" }, { label: "信用卡負債", value: -cardDebt, detail: `${cards.length} 張卡片`, tone: "text-coral" }] as item (item.label)}
        <Card
          ><CardContent class="p-5"
            ><p class="text-xs font-semibold text-ink/50">{item.label}</p>
            <p
              class={`mt-2 text-2xl font-bold tracking-tight tabular-nums ${item.tone}`}
            >
              {formatCurrency(item.value)}
            </p>
            <p class="mt-1 text-xs text-ink/45">{item.detail}</p></CardContent
          ></Card
        >
      {/each}
    </div>

    <TabsList class="grid h-auto w-full grid-cols-5 bg-card shadow-xs">
      {#each tabs as tab (tab.key)}
        <TabsTrigger
          class={`min-h-10 min-w-0 px-1 text-xs sm:text-sm ${section === tab.key ? "bg-ink text-white" : ""}`}
          active={section === tab.key}
          onclick={() => (section = tab.key)}>{tab.label}</TabsTrigger
        >
      {/each}
    </TabsList>

    {#if section === "all"}
      <div class="grid gap-3 xl:hidden">
        <Card>
          <CardHeader class="flex-row items-center justify-between py-4"
            ><div>
              <h2 class="text-lg font-semibold">銀行與現金</h2>
              <p class="mt-1 text-xs text-ink/45">各銀行彙整，外幣換算為 TWD</p>
            </div>
            <button
              class="text-xs font-semibold text-steel"
              onclick={() => (section = "bank")}
              >總額 {formatCurrency(bankTotal)}</button
            ></CardHeader
          >
          <CardContent class="pt-0">
            <div class="divide-y divide-ink/8">
              {#each groupedBanks as group (group.institution)}
                <button
                  class="flex min-h-16 w-full items-center justify-between gap-3 py-3 text-left"
                  onclick={() => (section = "bank")}
                >
                  <div class="flex min-w-0 items-center gap-3">
                    <span
                      class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-steel/10 text-steel"
                      ><Building2 class="size-4" /></span
                    >
                    <div class="min-w-0">
                      <h3 class="truncate font-semibold">
                        {group.institution}
                      </h3>
                      <p class="mt-1 truncate text-xs text-ink/45">
                        {group.accounts.length} 個帳戶{group.foreignCurrencies
                          .length
                          ? ` · 含 ${group.foreignCurrencies.join("、")}`
                          : ""}
                      </p>
                    </div>
                  </div>
                  <p class="shrink-0 font-bold tabular-nums text-steel">
                    {formatCurrency(group.totalTwd)}
                  </p>
                </button>
              {/each}
            </div>
          </CardContent>
        </Card>
        <Card
          ><CardHeader class="flex-row items-center justify-between"
            ><h2 class="text-lg font-semibold">投資</h2>
            <span class="text-sm font-bold tabular-nums text-steel"
              >{formatCurrency(investmentTotal)}</span
            ></CardHeader
          ><CardContent
            ><button
              class="flex w-full items-center justify-between gap-4 text-left"
              onclick={() => (section = "investments")}
              ><div>
                <p class="font-semibold">主要投資帳戶</p>
                <p class="text-xs text-ink/45">
                  {$investments.data?.length ?? 0} 個持倉 · TDCC
                </p>
              </div>
              <span class="text-xs font-semibold text-steel">查看持倉 →</span
              ></button
            ></CardContent
          ></Card
        >
        <Card
          ><CardHeader class="flex-row items-center justify-between"
            ><h2 class="text-lg font-semibold">其他資產</h2>
            <span class="font-bold tabular-nums text-moss"
              >{formatCurrency(manualTotal)}</span
            ></CardHeader
          ><CardContent class="pt-0"
            ><button
              class="text-left text-xs text-ink/45"
              onclick={() => (section = "manual-assets")}
              >保險、房產、交通工具 · 更新估值 →</button
            ></CardContent
          ></Card
        >
      </div>

      <div
        class="hidden gap-5 xl:grid xl:grid-cols-[minmax(0,2fr)_minmax(300px,0.8fr)]"
      >
        <div class="grid content-start gap-5">
          <Card>
            <CardHeader
              class="flex-row items-center justify-between border-b border-ink/8"
              ><div>
                <h2 class="text-lg font-semibold">銀行帳戶</h2>
                <p class="text-xs text-ink/45">{deposits.length} 個帳戶</p>
              </div>
              <Button size="sm" variant="ghost" onclick={() => navigate("bank")}
                >查看交易 →</Button
              ></CardHeader
            >
            <div class="divide-y divide-ink/8">
              {#each groupedBanks as group (group.institution)}
                <div class="p-4">
                  <div class="mb-2 flex items-center justify-between gap-3">
                    <h3 class="font-semibold">{group.institution}</h3>
                    <div class="flex items-center gap-3">
                      <span class="text-xs font-bold tabular-nums text-steel"
                        >{formatCurrency(group.totalTwd)}</span
                      ><span class="text-xs font-medium text-moss">已同步</span>
                    </div>
                  </div>
                  <div class="grid gap-2">
                    {#each group.accounts as account (account.id)}
                      <div
                        class="flex items-center justify-between gap-4 text-sm"
                      >
                        <span class="min-w-0 truncate text-ink/60"
                          >{account.accountName ??
                            formatBankAccountName(account)}</span
                        ><span class="shrink-0 font-semibold tabular-nums"
                          >{formatCurrency(
                            account.balance ?? 0,
                            account.currency,
                          )}</span
                        >
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </Card>
          <Card>
            <CardHeader
              class="flex-row items-center justify-between border-b border-ink/8"
              ><div>
                <h2 class="text-lg font-semibold">投資持倉</h2>
                <p class="text-xs text-ink/45">
                  市值 {formatCurrency(investmentTotal)}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => navigate("investments")}>查看全部 →</Button
              ></CardHeader
            >
            <div class="divide-y divide-ink/8">
              {#each ($investments.data ?? []).slice(0, 5) as item (item.id)}
                <div
                  class="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 text-sm"
                >
                  <span class="font-semibold text-steel"
                    >{item.symbol ?? item.assetType.toUpperCase()}</span
                  ><span class="min-w-0 truncate font-medium">{item.name}</span
                  ><span class="font-semibold tabular-nums"
                    >{formatCurrency(
                      (item.marketValue ?? 0) + (item.cashBalance ?? 0),
                      item.currency,
                    )}</span
                  >
                </div>
              {/each}
            </div>
          </Card>
        </div>
        <div class="grid content-start gap-5">
          <Card
            ><CardHeader class="flex-row items-center justify-between"
              ><h2 class="text-lg font-semibold">信用卡</h2>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => navigate("cards")}>查看交易 →</Button
              ></CardHeader
            ><CardContent
              ><div class="rounded-xl bg-ink p-4 text-white">
                <p class="text-xs text-white/60">目前負債</p>
                <p class="mt-2 text-2xl font-bold tabular-nums">
                  {formatCurrency(cardDebt)}
                </p>
                <p class="mt-2 text-xs text-white/55">{cards.length} 張卡片</p>
              </div></CardContent
            ></Card
          >
          <Card
            ><CardHeader class="flex-row items-center justify-between"
              ><h2 class="text-lg font-semibold">其他資產</h2>
              <Button
                size="sm"
                variant="ghost"
                onclick={() => navigate("manual-assets")}>更新估值</Button
              ></CardHeader
            ><CardContent
              ><p class="text-2xl font-bold tabular-nums text-moss">
                {formatCurrency(manualTotal)}
              </p>
              <p class="mt-2 text-xs text-ink/45">
                保險、不動產、交通工具與其他
              </p></CardContent
            ></Card
          >
        </div>
      </div>
    {:else if section === "bank"}
      <Card>
        <CardHeader class="flex-row items-center justify-between"
          ><div>
            <h2 class="flex items-center gap-2 text-lg font-semibold">
              <Building2 class="size-5 text-steel" />銀行帳戶
            </h2>
            <p class="mt-1 text-xs text-ink/45">依銀行分組，總額由大到小排列</p>
          </div>
          <Button size="sm" variant="ghost" onclick={() => navigate("bank")}
            >查看所有交易 →</Button
          ></CardHeader
        >
        <div class="divide-y divide-ink/8">
          {#each groupedBanks as group (group.institution)}
            <section class="px-5 py-4">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <h3 class="font-semibold">{group.institution}</h3>
                  <p class="mt-1 text-xs text-ink/45">
                    {group.accounts.length} 個帳戶
                  </p>
                </div>
                <p class="font-bold tabular-nums text-steel">
                  {formatCurrency(group.totalTwd)}
                </p>
              </div>
              <div class="mt-3 grid gap-2 md:grid-cols-2">
                {#each group.accounts as account (account.id)}<div
                    class="rounded-xl border border-ink/8 p-3"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <p class="truncate text-sm font-semibold">
                          {account.accountName ??
                            formatBankAccountName(account)}
                        </p>
                        <p class="mt-1 text-xs text-ink/45">
                          {account.currency} · {account.asOfAt
                            ? `更新 ${formatDate(account.asOfAt)}`
                            : "尚未同步"}
                        </p>
                      </div>
                      <p class="shrink-0 font-bold tabular-nums">
                        {formatCurrency(account.balance ?? 0, account.currency)}
                      </p>
                    </div>
                  </div>{/each}
              </div>
            </section>
          {/each}
        </div>
      </Card>
    {:else if section === "cards"}
      <Card
        ><CardHeader class="flex-row items-center justify-between"
          ><div>
            <h2 class="text-lg font-semibold">信用卡帳戶</h2>
            <p class="mt-1 text-xs text-ink/45">
              目前負債 {formatCurrency(cardDebt)}
            </p>
          </div>
          <Button size="sm" variant="ghost" onclick={() => navigate("cards")}
            >查看刷卡紀錄 →</Button
          ></CardHeader
        ><CardContent
          >{#if cards.length === 0}<p
              class="py-8 text-center text-sm text-ink/45"
            >
              尚無信用卡資料。
            </p>{:else}<div class="grid gap-3 md:grid-cols-2">
              {#each cards as card, index (card.id)}<button
                  class={`w-full rounded-2xl p-4 text-left text-white ${index % 2 === 0 ? "bg-ink" : "bg-steel"}`}
                  onclick={() => navigate("cards")}
                  ><div class="flex items-start justify-between">
                    <div>
                      <p class="font-semibold">
                        {card.institutionName ?? card.connectorId}
                      </p>
                      <p class="mt-2 text-xs text-white/65">
                        {card.accountName ?? formatBankAccountName(card)}
                      </p>
                    </div>
                    <CreditCard class="size-5 text-white/70" />
                  </div>
                  <p class="mt-5 text-2xl font-bold tabular-nums">
                    {formatCurrency(Math.abs(card.balance ?? 0), card.currency)}
                  </p></button
                >{/each}
            </div>{/if}</CardContent
        ></Card
      >
    {:else if section === "investments"}
      <Card
        ><CardHeader class="flex-row items-center justify-between"
          ><div>
            <h2 class="text-lg font-semibold">投資持倉</h2>
            <p class="mt-1 text-xs text-ink/45">
              市值 {formatCurrency(investmentTotal)}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => navigate("investments")}>交易紀錄 →</Button
          ></CardHeader
        ><CardContent
          ><div class="divide-y divide-ink/8">
            {#each $investments.data ?? [] as item (item.id)}<button
                class="flex min-h-16 w-full items-center justify-between gap-3 py-3 text-left"
                onclick={() => navigate("investments")}
                ><div class="min-w-0">
                  <p class="truncate font-semibold">
                    {item.symbol ? `${item.symbol} ` : ""}{item.name}
                  </p>
                  <p class="mt-1 text-xs text-ink/45">
                    {formatNumber(item.quantity ?? 0)} 單位 · {item.assetType.toUpperCase()}
                  </p>
                </div>
                <p class="shrink-0 font-bold tabular-nums text-steel">
                  {formatCurrency(
                    (item.marketValue ?? 0) + (item.cashBalance ?? 0),
                    item.currency,
                  )}
                </p></button
              >{/each}
          </div></CardContent
        ></Card
      >
    {:else}
      <Card
        ><CardHeader class="flex-row items-center justify-between"
          ><div>
            <h2 class="text-lg font-semibold">其他資產</h2>
            <p class="mt-1 text-xs text-ink/45">
              合計 {formatCurrency(manualTotal)}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => navigate("manual-assets")}>＋ 新增資產</Button
          ></CardHeader
        ><CardContent
          ><div class="divide-y divide-ink/8">
            {#each $manual.data ?? [] as item (item.id)}<button
                class="flex min-h-16 w-full items-center justify-between gap-3 py-3 text-left"
                onclick={() => navigate("manual-assets")}
                ><div class="min-w-0">
                  <p class="truncate font-semibold">{item.name}</p>
                  <p class="mt-1 truncate text-xs text-ink/45">
                    {item.category} · {item.date
                      ? `${formatDate(item.date)} 更新`
                      : "查看估值歷史"}
                  </p>
                </div>
                <p class="shrink-0 font-bold tabular-nums text-moss">
                  {formatCurrency(item.value ?? 0, item.currency)}
                </p></button
              >{/each}
          </div></CardContent
        ></Card
      >
    {/if}
  </div>
{/if}
