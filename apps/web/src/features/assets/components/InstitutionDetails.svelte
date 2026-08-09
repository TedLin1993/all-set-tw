<script lang="ts">
  import type { CreditCardBillRow } from "@/data/bank/types";
  import {
    formatBankAccountName,
    formatCurrency,
    formatDate,
  } from "@/shared/format/financial";
  import type { InstitutionAssetGroup } from "../model/summary";

  let {
    group,
    bills,
    billsPending = false,
    billsError = false,
    compact = false,
  }: {
    group: InstitutionAssetGroup;
    bills: CreditCardBillRow[];
    billsPending?: boolean;
    billsError?: boolean;
    compact?: boolean;
  } = $props();

  const cardsById = $derived(
    new Map(group.cards.map((card) => [card.id, card])),
  );
  const institutionBills = $derived(
    bills
      .filter((bill) => cardsById.has(bill.accountId))
      .sort((a, b) => b.billingPeriod.localeCompare(a.billingPeriod)),
  );

  function billAccountName(bill: CreditCardBillRow) {
    const card = cardsById.get(bill.accountId);
    return card?.accountName ?? card?.institutionName ?? "信用卡帳戶";
  }

  function paymentStatusLabel(isPaid?: number) {
    if (isPaid === 1) return "已繳";
    if (isPaid === 0) return "待繳";
    return "狀態未提供";
  }
</script>

<div class={compact ? "grid gap-3" : "flex min-h-full flex-col"}>
  {#if !compact}
    <header class="border-b border-border px-5 py-4">
      <p class="text-xs font-semibold text-muted-foreground">金融機構</p>
      <h2 class="mt-1 text-xl font-semibold tracking-tight">
        {group.institution}
      </h2>
      <p class="mt-1 text-xs text-muted-foreground">
        帳戶與信用卡依各自資料來源顯示
      </p>
    </header>
    <div class="grid grid-cols-2 gap-2 border-b border-border p-4">
      <div class="rounded-lg border border-border bg-paper p-3">
        <p class="text-xs text-muted-foreground">銀行資產</p>
        <p class="mt-1 text-lg font-bold tabular-nums text-steel">
          {group.accounts.length ? formatCurrency(group.assetTotalTwd) : "—"}
        </p>
      </div>
      <div class="rounded-lg border border-border bg-paper p-3">
        <p class="text-xs text-muted-foreground">信用卡負債</p>
        <p class="mt-1 text-lg font-bold tabular-nums text-coral">
          {group.cards.length ? formatCurrency(-group.debtTotalTwd) : "—"}
        </p>
      </div>
    </div>
  {/if}

  <section class={compact ? "" : "border-b border-border px-5 py-4"}>
    <div class="flex items-center justify-between gap-3">
      <h3 class="text-sm font-semibold">銀行帳戶</h3>
      <span class="text-xs text-muted-foreground">
        {group.accounts.length} 個帳戶
      </span>
    </div>
    {#if group.accounts.length === 0}
      <p class="py-3 text-sm text-muted-foreground">此機構沒有銀行帳戶。</p>
    {:else}
      <div class="mt-2 divide-y divide-border">
        {#each group.accounts as account (account.id)}
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3"
          >
            <div class="min-w-0">
              <p class="break-words text-sm font-semibold">
                {account.accountName ?? formatBankAccountName(account)}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                {account.currency}{account.asOfAt
                  ? ` · 更新 ${formatDate(account.asOfAt)}`
                  : " · 尚未取得更新時間"}
              </p>
            </div>
            <p class="text-right text-sm font-bold tabular-nums text-steel">
              {formatCurrency(account.balance ?? 0, account.currency)}
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class={compact ? "" : "border-b border-border px-5 py-4"}>
    <div class="flex items-center justify-between gap-3">
      <h3 class="text-sm font-semibold">信用卡帳戶</h3>
      <span class="text-xs text-muted-foreground">
        {group.cards.length} 張卡片
      </span>
    </div>
    {#if group.cards.length === 0}
      <p class="py-3 text-sm text-muted-foreground">此機構沒有信用卡。</p>
    {:else}
      <div class="mt-2 divide-y divide-border">
        {#each group.cards as card (card.id)}
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3"
          >
            <div class="min-w-0">
              <p class="break-words text-sm font-semibold">
                {card.accountName ?? formatBankAccountName(card)}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                {card.paymentDueDate
                  ? `繳款期限 ${formatDate(card.paymentDueDate)}`
                  : "繳款期限待同步"}
              </p>
            </div>
            <p class="text-right text-sm font-bold tabular-nums text-coral">
              {formatCurrency(-Math.abs(card.balance ?? 0), card.currency)}
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if group.cards.length > 0}
    <details class={compact ? "rounded-lg border border-border" : "m-4"}>
      <summary
        class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-border bg-white px-3 text-sm font-semibold hover:bg-muted"
      >
        查看信用卡帳單
        <span class="text-xs font-normal text-muted-foreground">
          {institutionBills.length} 筆
        </span>
      </summary>
      <div class="divide-y divide-border px-3">
        {#if billsPending}
          <p class="py-4 text-sm text-muted-foreground">正在載入帳單。</p>
        {:else if billsError}
          <p class="py-4 text-sm text-coral">信用卡帳單暫時無法載入。</p>
        {:else if institutionBills.length === 0}
          <p class="py-4 text-sm text-muted-foreground">尚無信用卡帳單。</p>
        {:else}
          {#each institutionBills as bill (bill.id)}
            <div class="grid gap-1 py-3 sm:grid-cols-[1fr_auto] sm:gap-3">
              <div>
                <p class="text-sm font-semibold">{billAccountName(bill)}</p>
                <p class="mt-1 text-xs text-muted-foreground">
                  {bill.billingPeriod} · {bill.paymentDueDate
                    ? `期限 ${formatDate(bill.paymentDueDate)}`
                    : "期限未提供"} · {paymentStatusLabel(bill.isPaid)}
                </p>
              </div>
              <p class="text-sm font-bold tabular-nums">
                {bill.statementAmount == null
                  ? "—"
                  : formatCurrency(bill.statementAmount, bill.currency)}
              </p>
            </div>
          {/each}
        {/if}
      </div>
    </details>
  {/if}
</div>
