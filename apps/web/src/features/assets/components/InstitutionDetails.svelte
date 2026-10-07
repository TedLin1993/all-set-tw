<script lang="ts">
  import type { BankAccountRow, CreditCardBillRow } from "@/data/bank/types";
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

  function cardPaymentLabel(card: BankAccountRow) {
    if (card.balance != null && card.balance > 0) return "溢繳餘額，無需繳款";
    const latestBill = institutionBills.find(
      (bill) => bill.accountId === card.id,
    );
    if (latestBill?.isPaid === 1) {
      return latestBill.paymentDueDate
        ? `最近帳單已繳 · 期限 ${formatDate(latestBill.paymentDueDate)}`
        : "最近帳單已繳";
    }
    const dueDate = card.paymentDueDate ?? latestBill?.paymentDueDate;
    if (latestBill?.isPaid === 0) {
      return dueDate ? `帳單待繳 · 期限 ${formatDate(dueDate)}` : "帳單待繳";
    }
    if (dueDate) return `繳款期限 ${formatDate(dueDate)}`;
    return card.balance == null ? "繳款期限待同步" : "繳款期限尚未提供";
  }

  function paymentStatusLabel(bill: CreditCardBillRow) {
    if (bill.isPaid === 1)
      return bill.statementAmount != null && bill.statementAmount <= 0
        ? "無需繳款"
        : "已繳";
    if (bill.isPaid === 0) return "待繳";
    return "狀態未提供";
  }

  function loanPaymentLabel(loan: BankAccountRow) {
    const details = [
      loan.loanInterestRate != null ? `利率 ${loan.loanInterestRate}%` : null,
      loan.loanPaymentAmount != null
        ? `本期應繳 ${formatCurrency(loan.loanPaymentAmount, loan.currency)}`
        : null,
      loan.loanPaymentStatus === "collection_incomplete"
        ? loan.paymentDueDate
          ? `扣款未完成 · 期限 ${formatDate(loan.paymentDueDate)}`
          : "扣款未完成"
        : loan.paymentDueDate
          ? `扣款日 ${formatDate(loan.paymentDueDate)}`
          : null,
      loan.loanInstallmentsPaid != null && loan.loanInstallmentsTotal != null
        ? `已繳 ${loan.loanInstallmentsPaid} / 共 ${loan.loanInstallmentsTotal} 期`
        : null,
    ].filter((value): value is string => value !== null);
    return details.join(" · ") || "貸款明細尚未提供";
  }
</script>

<div class={compact ? "grid gap-3" : "flex min-h-full flex-col"}>
  {#if !compact}
    <header class="border-b border-ink/10 px-5 py-4">
      <p class="text-caption font-medium text-subtle">金融機構</p>
      <h2 class="mt-1 text-xl font-semibold tracking-tight">
        {group.institution}
      </h2>
      <p class="mt-1 text-caption text-subtle">
        帳戶與信用卡依各自資料來源顯示
      </p>
    </header>
    <div class="grid grid-cols-3 gap-4 border-b border-ink/10 px-5 py-4">
      <div>
        <p class="text-caption text-subtle">銀行資產</p>
        <p class="mt-2 text-lg font-medium tabular-nums text-steel">
          {group.accounts.length ? formatCurrency(group.assetTotalTwd) : "—"}
        </p>
      </div>
      <div>
        <p class="text-caption text-subtle">貸款負債</p>
        <p class="mt-2 text-lg font-medium tabular-nums text-coral">
          {group.hasUnknownLoanBalance
            ? "資料不完整"
            : group.loans.length
              ? formatCurrency(group.loanDebtTotalTwd)
              : "—"}
        </p>
      </div>
      <div>
        <p class="text-caption text-subtle">
          {group.debtTotalTwd < 0 ? "信用卡溢繳餘額" : "信用卡負債"}
        </p>
        <p class="mt-2 text-lg font-medium tabular-nums text-coral">
          {group.hasUnknownCardBalance
            ? "資料不完整"
            : group.cards.length
              ? formatCurrency(-group.debtTotalTwd)
              : "—"}
        </p>
      </div>
    </div>
  {/if}

  <section class={compact ? "" : "border-b border-ink/10 px-5 py-4"}>
    <div class="flex items-center justify-between gap-3">
      <h3
        class={compact
          ? "text-caption font-medium text-subtle"
          : "text-sm font-semibold"}
      >
        銀行帳戶
      </h3>
      <span class="text-caption text-subtle">
        {group.accounts.length} 個帳戶
      </span>
    </div>
    {#if group.accounts.length === 0}
      <p class="py-3 text-sm text-subtle">此機構沒有銀行帳戶。</p>
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
              {#if account.accountType === "time_deposit"}
                <p class="mt-1 text-caption text-subtle">
                  起息日 {account.openedDate
                    ? formatDate(account.openedDate)
                    : "尚未取得"}
                  · 到期日 {account.maturityDate
                    ? formatDate(account.maturityDate)
                    : "尚未取得"}
                </p>
              {/if}
              <p class="mt-1 text-caption text-subtle">
                {account.currency}{account.asOfAt
                  ? ` · 更新 ${formatDate(account.asOfAt)}`
                  : " · 尚未取得更新時間"}
              </p>
            </div>
            <p class="text-right text-sm font-medium tabular-nums text-steel">
              {formatCurrency(account.balance ?? 0, account.currency)}
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class={compact ? "" : "border-b border-ink/10 px-5 py-4"}>
    <div class="flex items-center justify-between gap-3">
      <h3
        class={compact
          ? "text-caption font-medium text-subtle"
          : "text-sm font-semibold"}
      >
        貸款帳戶
      </h3>
      <span class="text-caption text-subtle">{group.loans.length} 筆貸款</span>
    </div>
    {#if group.loans.length === 0}
      <p class="py-3 text-sm text-subtle">此機構沒有貸款。</p>
    {:else}
      <div class="mt-2 divide-y divide-border">
        {#each group.loans as loan (loan.id)}
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3"
          >
            <div class="min-w-0">
              <p class="break-words text-sm font-semibold">
                {loan.accountName ?? "貸款帳戶"}
              </p>
              <p class="mt-1 text-caption text-subtle">
                {loanPaymentLabel(loan)}
              </p>
              <p class="mt-1 text-caption text-subtle">
                {loan.currency}{loan.asOfAt
                  ? ` · 更新 ${formatDate(loan.asOfAt)}`
                  : " · 尚未取得更新時間"}
              </p>
            </div>
            <p class="text-right text-sm font-medium tabular-nums text-coral">
              {loan.balance == null
                ? "剩餘貸款餘額未取得"
                : formatCurrency(Math.abs(loan.balance), loan.currency)}
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class={compact ? "" : "border-b border-ink/10 px-5 py-4"}>
    <div class="flex items-center justify-between gap-3">
      <h3
        class={compact
          ? "text-caption font-medium text-subtle"
          : "text-sm font-semibold"}
      >
        信用卡帳戶
      </h3>
      <span class="text-caption text-subtle">
        {group.cards.length} 張卡片
      </span>
    </div>
    {#if group.cards.length === 0}
      <p class="py-3 text-sm text-subtle">此機構沒有信用卡。</p>
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
              <p class="mt-1 text-caption text-subtle">
                {cardPaymentLabel(card)}
              </p>
            </div>
            <p class="text-right text-sm font-medium tabular-nums text-coral">
              {card.balance == null
                ? "剩餘應繳金額未取得"
                : formatCurrency(card.balance, card.currency)}
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  {#if group.cards.length > 0}
    <details
      class={compact
        ? "border-t border-ink/8 pt-1"
        : "mx-5 border-t border-ink/10"}
    >
      <summary
        class={compact
          ? "flex min-h-11 cursor-pointer items-center justify-between gap-3 text-caption font-medium text-subtle"
          : "flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm font-medium"}
      >
        查看信用卡帳單
        <span class="text-caption font-normal text-subtle">
          {institutionBills.length} 筆
        </span>
      </summary>
      <div class="divide-y divide-border px-3">
        {#if billsPending}
          <p class="py-4 text-sm text-subtle">正在載入帳單。</p>
        {:else if billsError}
          <p class="py-4 text-sm text-coral">信用卡帳單暫時無法載入。</p>
        {:else if institutionBills.length === 0}
          <p class="py-4 text-sm text-subtle">尚無信用卡帳單。</p>
        {:else}
          {#each institutionBills as bill (bill.id)}
            <div class="grid gap-1 py-3 sm:grid-cols-[1fr_auto] sm:gap-3">
              <div>
                <p class="text-sm font-semibold">{billAccountName(bill)}</p>
                <p class="mt-1 text-caption text-subtle">
                  {bill.billingPeriod} · {bill.paymentDueDate
                    ? `期限 ${formatDate(bill.paymentDueDate)}`
                    : "期限未提供"} · {paymentStatusLabel(bill)}
                </p>
              </div>
              <p class="text-sm font-medium tabular-nums">
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
