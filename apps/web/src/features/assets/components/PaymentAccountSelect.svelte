<script lang="ts">
  import { ChevronDown } from "@lucide/svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { BankAccountRow } from "@/data/bank/types";
  import type { ApiClient } from "@/shared/api/client";
  import { formatBankAccountName } from "@/shared/format/financial";

  let {
    api,
    account,
    accounts,
  }: {
    api: ApiClient;
    /** 信用卡或貸款帳戶。 */
    account: BankAccountRow;
    accounts: BankAccountRow[];
  } = $props();

  const AUTO = "__auto";
  const NONE = "__none";
  const NON_PAYMENT_TYPES = new Set([
    "credit",
    "loan",
    "time_deposit",
    "stored_value",
  ]);
  const queryClient = useQueryClient();
  let saving = $state(false);
  let error = $state<string | null>(null);

  // 與 Worker 驗證相同：同幣別或台幣的活存類帳戶才能扣款（外幣帳單可由台幣帳戶扣繳）。
  const candidates = $derived(
    accounts.filter(
      (item) =>
        !NON_PAYMENT_TYPES.has(item.accountType ?? "") &&
        (item.currency === account.currency || item.currency === "TWD"),
    ),
  );
  const accountsById = $derived(
    new Map(accounts.map((item) => [item.id, item])),
  );
  // 同一資料來源即同一家銀行。
  const sameBank = $derived(
    candidates.filter((item) => item.connectorId === account.connectorId),
  );
  /** 依銀行分組，同銀行排第一，其他銀行依名稱排序。 */
  const groups = $derived.by(() => {
    const others = new Map<string, BankAccountRow[]>();
    for (const item of candidates) {
      if (item.connectorId === account.connectorId) continue;
      const key = item.institutionName ?? "其他";
      others.set(key, [...(others.get(key) ?? []), item]);
    }
    return [
      ...(sameBank.length
        ? [
            {
              label: `${account.institutionName ?? "同銀行"}（同銀行）`,
              items: sameBank,
            },
          ]
        : []),
      ...[...others.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "zh-Hant"))
        .map(([label, items]) => ({ label, items })),
    ];
  });
  const value = $derived(
    account.paymentAccountSource === "manual"
      ? (account.paymentAccountId ?? NONE)
      : AUTO,
  );

  function accountLabel(item: BankAccountRow) {
    return item.accountName ?? formatBankAccountName(item);
  }

  function fullLabel(item: BankAccountRow) {
    return [item.institutionName, accountLabel(item)].filter(Boolean).join(" ");
  }

  /** 他行帳戶顯示完整名稱，收合時才看得出是哪家銀行。 */
  function optionLabel(item: BankAccountRow) {
    const name =
      item.connectorId === account.connectorId
        ? accountLabel(item)
        : fullLabel(item);
    return account.currency === "TWD" ? name : `${name}（${item.currency}）`;
  }

  const autoLabel = $derived.by(() => {
    const bank = account.bankAutopay;
    // 與 Worker 相同：銀行未提供時，同銀行唯一的同幣別帳戶即為推測的扣款帳戶。
    if (!bank) {
      const inferable = sameBank.filter(
        (item) => item.currency === account.currency,
      );
      return inferable.length === 1
        ? `自動：${fullLabel(inferable[0]!)}`
        : "自動：無法判斷，請選擇";
    }
    if (bank.status === "none") return "自動：銀行顯示未約定自動扣繳";
    const matched = bank.accountId ? accountsById.get(bank.accountId) : null;
    if (matched) return `銀行約定：${fullLabel(matched)}`;
    return bank.last4
      ? `自動：找不到末四碼 ${bank.last4} 的帳戶`
      : "自動：找不到銀行提供的帳戶";
  });
  const selectedLabel = $derived.by(() => {
    if (value === AUTO) return autoLabel;
    const item = value === NONE ? null : accountsById.get(value);
    return item ? optionLabel(item) : "不指定";
  });

  async function change(next: string) {
    saving = true;
    error = null;
    try {
      const path = `/api/bank/accounts/${encodeURIComponent(account.id)}/payment-account`;
      if (next === AUTO) await api.delete(path);
      else
        await api.put(path, {
          paymentAccountId: next === NONE ? null : next,
        });
      await queryClient.invalidateQueries({ queryKey: ["bank"] });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "扣款帳戶儲存失敗。";
    } finally {
      saving = false;
    }
  }
</script>

<div class="mt-1 min-w-0 text-caption text-subtle">
  <div class="flex min-w-0 items-center gap-1.5">
    <span class="shrink-0" aria-hidden="true">扣款帳戶</span>
    <!-- 手機版全域將 select 設為 16px 以免 iOS 聚焦時放大；原生 select 透明覆蓋在小字標籤上，保留原生選單。 -->
    <span
      class="relative flex min-w-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-ink hover:bg-ink/4 has-[:disabled]:opacity-60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
    >
      <span class="truncate underline decoration-ink/20 underline-offset-4"
        >{selectedLabel}</span
      >
      <ChevronDown class="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      <select
        class="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-wait"
        aria-label="扣款帳戶"
        {value}
        disabled={saving}
        onchange={(event) => change(event.currentTarget.value)}
      >
        <option value={AUTO}>{autoLabel}</option>
        <option value={NONE}>不指定</option>
        {#each groups as group (group.label)}
          <optgroup label={group.label}>
            {#each group.items as item (item.id)}
              <option value={item.id}>{optionLabel(item)}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </span>
  </div>
  {#if error}
    <p class="mt-1 text-coral">{error}</p>
  {/if}
</div>
