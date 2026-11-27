<script lang="ts">
  import { AlertDialog } from "bits-ui";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { Unlink } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Checkbox from "@/shared/ui/Checkbox.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { ApiRequestError, messageFromError } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import { formatNumber } from "@/shared/format/financial";
  import { connectorDataSummaryQuery } from "@/data/connectors/queries";
  import type {
    ConnectorId,
    ConnectorUnlinkResponse,
  } from "@/data/connectors/types";

  let {
    api,
    connectorId,
    title,
    demoMode,
    syncBusy,
    credentialBusy,
    onUnlinked,
  }: {
    api: ApiClient;
    connectorId: ConnectorId;
    title: string;
    demoMode: boolean;
    syncBusy: boolean;
    /** 儲存或連線流程正在寫入憑證；此時解除連結，稍後完成的寫入會把憑證建回來。 */
    credentialBusy: boolean;
    onUnlinked: () => void;
  } = $props();

  const qc = useQueryClient();
  let open = $state(false);
  let deleteData = $state(false);
  let acknowledged = $state(false);
  let error = $state("");
  const summary = createQuery(() => ({
    ...connectorDataSummaryQuery(() => api, connectorId),
    enabled: open && deleteData,
  }));

  const dataLines = $derived.by(() => {
    const data = summary.data?.data;
    if (!data) return [];
    return [
      ["帳戶", data.accounts, "個"],
      ["交易", data.transactions, "筆"],
      ["餘額紀錄", data.balanceSnapshots, "筆"],
      ["信用卡帳單", data.creditCardBills, "期"],
      ["發票", data.invoices, "張"],
      ["持倉紀錄", data.investmentPositions, "筆"],
      ["投資成交", data.investmentTransactions, "筆"],
    ] as const;
  });
  const editLines = $derived.by(() => {
    const edits = summary.data?.userEdits;
    if (!edits) return [];
    return [
      ["手動分類", edits.categoryOverrides],
      ["備註與計入設定", edits.transactionPreferences],
      ["發票配對", edits.invoiceLinks],
      ["扣款帳戶設定", edits.paymentAccounts],
    ] as const;
  });
  const hasData = $derived(dataLines.some(([, value]) => value > 0));
  const hasEdits = $derived(editLines.some(([, value]) => value > 0));

  const unlink = createMutation(() => ({
    mutationFn: (withData: boolean) =>
      api.delete<ConnectorUnlinkResponse>(
        `/api/connectors/${connectorId}/settings${withData ? "?deleteData=true" : ""}`,
      ),
    onSuccess: (result) => {
      open = false;
      // 刪除資料會影響帳戶、活動、資產與走勢，全部重新讀取；只解除連結時只有來源狀態改變。
      if (result.dataDeleted) void qc.invalidateQueries();
      else {
        void qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
        void qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
      }
      onUnlinked();
    },
    onError: (e) => {
      error =
        e instanceof ApiRequestError && e.code === "SYNC_ALREADY_RUNNING"
          ? "此來源正在同步，請等同步結束後再解除連結。"
          : messageFromError(e);
      void qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    },
  }));
  // 刪除模式即使七類資料都是 0，也會刪除同步紀錄與淨資產歷史，因此一律要求確認。
  const canConfirm = $derived(
    !unlink.isPending && (!deleteData || (summary.isSuccess && acknowledged)),
  );

  function reset() {
    deleteData = false;
    acknowledged = false;
    error = "";
    unlink.reset();
  }
</script>

<section class="mt-6 border-t border-border pt-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="min-w-0">
      <h3 class="text-sm font-semibold">解除連結</h3>
      <p class="mt-0.5 text-sm text-muted-foreground">
        {syncBusy
          ? "同步進行中，結束後才能解除連結。"
          : "刪除已儲存的登入資訊並停止同步，可選擇是否一併刪除已同步的資料。"}
      </p>
    </div>
    <Button
      size="sm"
      variant="outline"
      class="border-coral/40 text-coral hover:bg-coral/10 hover:text-coral"
      disabled={demoMode || syncBusy || credentialBusy}
      onclick={() => {
        reset();
        open = true;
      }}><Unlink class="size-4" />解除連結</Button
    >
  </div>
</section>

<!-- bits-ui AlertDialog 負責焦點限制、Esc 關閉與背景捲動鎖定；點擊背景不關閉，避免誤觸。 -->
<AlertDialog.Root bind:open>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-[70] bg-inverse/45" />
    <AlertDialog.Content
      class="fixed inset-x-0 bottom-0 z-[70] max-h-[88vh] overflow-y-auto rounded-t-2xl bg-card p-5 shadow-2xl outline-none md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-[calc(100%-3rem)] md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:p-6"
    >
      <AlertDialog.Title level={2} class="text-xl font-semibold">
        解除連結「{title}」
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-sm leading-relaxed text-subtle">
        會刪除已儲存的帳號密碼與登入狀態，並停止這個來源的同步。之後可以從「新增資料來源」重新連結。
      </AlertDialog.Description>

      <fieldset class="mt-4 grid gap-2" disabled={unlink.isPending}>
        <legend class="sr-only">已同步的資料</legend>
        <label
          class={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${deleteData ? "border-border" : "border-steel/40 bg-steel/[0.055]"}`}
        >
          <input
            type="radio"
            name={`unlink-${connectorId}`}
            class="mt-0.5 accent-primary"
            checked={!deleteData}
            onchange={() => (deleteData = false)}
          />
          <span>
            <span class="font-semibold">只解除連結</span>
            <span class="mt-0.5 block text-muted-foreground"
              >保留已同步的帳戶、交易與歷史紀錄。</span
            >
          </span>
        </label>
        <label
          class={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${deleteData ? "border-coral/40 bg-coral/[0.06]" : "border-border"}`}
        >
          <input
            type="radio"
            name={`unlink-${connectorId}`}
            class="mt-0.5 accent-primary"
            checked={deleteData}
            onchange={() => (deleteData = true)}
          />
          <span>
            <span class="font-semibold">解除連結並刪除資料</span>
            <span class="mt-0.5 block text-muted-foreground"
              >一併刪除這個來源同步進來的資料。</span
            >
          </span>
        </label>
      </fieldset>

      {#if deleteData}
        <div class="mt-4 text-sm" aria-live="polite">
          {#if summary.isPending}
            <p class="text-muted-foreground">正在計算會刪除的資料…</p>
          {:else if summary.isError}
            <p class="text-coral">無法取得資料筆數，請稍後再試。</p>
          {:else}
            {#if !hasData}
              <p class="text-muted-foreground">
                沒有同步進來的帳戶、交易、帳單、發票或投資資料；會刪除登入資訊與這個來源的同步紀錄。
              </p>
            {:else}
              <p class="font-semibold">會刪除下列資料：</p>
              <ul class="mt-2 grid list-disc gap-1 pl-5 text-subtle">
                {#each dataLines.filter(([, value]) => value > 0) as [label, value, unit] (label)}
                  <li>{label} {formatNumber(value)} {unit}</li>
                {/each}
              </ul>
              {#if hasEdits}
                <p class="mt-3 font-semibold">
                  你手動做過的調整也會一併刪除，無法復原：
                </p>
                <ul class="mt-2 grid list-disc gap-1 pl-5 text-subtle">
                  {#each editLines.filter(([, value]) => value > 0) as [label, value] (label)}
                    <li>{label} {formatNumber(value)} 筆</li>
                  {/each}
                </ul>
              {/if}
              <p class="mt-3 text-muted-foreground">
                重新連結後只能補回來源仍可查詢的期間，更早的紀錄無法再取得。
              </p>
            {/if}
            <label class="mt-3 flex items-start gap-2 font-medium">
              <Checkbox
                class="mt-0.5"
                checked={acknowledged}
                disabled={unlink.isPending}
                onchange={(event: Event) =>
                  (acknowledged = (event.currentTarget as HTMLInputElement)
                    .checked)}
              />
              我了解這些資料刪除後無法復原
            </label>
          {/if}
        </div>
      {/if}

      {#if error}<p class="mt-3 text-sm font-medium text-coral" role="alert">
          {error}
        </p>{/if}

      <div class="mt-5 grid grid-cols-2 gap-3">
        <AlertDialog.Cancel disabled={unlink.isPending}>
          {#snippet child({ props })}
            <Button {...props} variant="secondary">取消</Button>
          {/snippet}
        </AlertDialog.Cancel>
        <Button
          variant="destructive"
          disabled={!canConfirm}
          onclick={() => {
            error = "";
            unlink.mutate(deleteData);
          }}
          >{unlink.isPending
            ? "處理中…"
            : deleteData
              ? "解除並刪除資料"
              : "解除連結"}</Button
        >
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
