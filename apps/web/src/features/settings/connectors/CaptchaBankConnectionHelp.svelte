<script lang="ts">
  import { RefreshCw } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/shared";

  let {
    connectorId,
    captchaImage,
    captcha = $bindable(),
    digitCount,
    captchaKind = "numeric",
    preparing,
    verifying,
    syncing = false,
    expiresIn,
    onVerify,
    onRefresh,
  }: {
    connectorId: ConnectorId;
    captchaImage: string;
    captcha?: string;
    digitCount: number;
    captchaKind?: "numeric" | "alphanumeric";
    preparing: boolean;
    verifying: boolean;
    syncing?: boolean;
    expiresIn?: number;
    onVerify: () => void;
    onRefresh: () => void;
  } = $props();

  const expired = $derived(expiresIn !== undefined && expiresIn <= 0);
  const operationPending = $derived(preparing || verifying || syncing);

  const sessionGuide = [
    "首次或銀行 session 失效時，系統會自動辨識圖形驗證碼並登入。",
    "每次自動登入最多嘗試三張驗證碼，連續失敗後可改用人工輸入。",
  ];
  const captchaGuide =
    "每次同步會自動辨識 6 位數字驗證碼；連續失敗後可改用人工輸入。";
  const manualFallback = "若自動辨識失敗，可取得圖片後改用人工輸入。";
  /** 各來源的使用說明；未列出的來源會沿用網銀 session，使用通用說明。 */
  const guides: Partial<Record<ConnectorId, readonly string[]>> = {
    taishin: [
      ...sessionGuide,
      "台新可能會讓新的自動登入取代當下正在使用的網銀 session，建議先完成其他網銀操作。",
    ],
    obank: [
      "系統透過王道 App API 讀取資料，並自動辨識四位英數驗證碼。",
      manualFallback,
      "手動與排程同步必要時都會接管其他登入中的裝置；官方 App 可能需要重新登入。",
    ],
    megabank: [
      "系統透過兆豐 App API 讀取資料，並自動辨識五位數字驗證碼。",
      manualFallback,
      "一般帳密登入不需要快速登入或裝置綁定。",
    ],
    nextbank: [
      "按「同步帳戶」即可開始。若驗證碼辨識失敗，會自動顯示新圖片；填入後按「驗證並同步」。",
      "每次查詢後會登出，不接管其他登入。同步前請先結束銀行 App 操作。",
      "支援存款與口袋，不含美股及基金持倉。",
    ],
    rakuten: [
      "每次同步都會重新登入並自動辨識 4 位英數驗證碼；連續失敗後可改用人工輸入。",
      "同步結束時登出，不保留銀行 session。",
    ],
    kgibank: [
      captchaGuide,
      "凱基同一帳號僅允許單一登入：同步會登出行動銀行 App，完成後自動登出網銀。",
      "帳密被拒絕時會立即停止、不會重試，以免累積錯誤次數導致停權。",
    ],
    fubon: [
      captchaGuide,
      "非信任裝置登入需要雙重驗證：手動同步會請銀行寄送簡訊／Email 驗證碼，排程同步不會寄送，只會標記需要處理。",
      "若已有其他登入中的網銀，系統不會接管，會停止同步；完成後自動登出網銀。",
      "帳密被拒絕時會立即停止、不會重試，以免累積錯誤次數導致鎖定。",
    ],
    feib: [
      captchaGuide,
      "驗證碼會先由網銀頁面檢核，錯誤時不會送出密碼；帳密被拒絕時會立即停止，以免連續錯誤三次遭停用。",
      "若出現年度密碼變更提醒，系統只會選擇「下次登入再變更」，不會變更密碼；同步完成後自動登出網銀。",
    ],
  };
  const guide = $derived(guides[connectorId] ?? sessionGuide);
</script>

{#snippet captchaPanel()}
  {#if captchaImage}
    <div class="mt-3 rounded-md border border-ink/10 bg-paper p-3">
      <p class="text-sm font-medium text-ink/80">
        請輸入圖片中的 {digitCount} 位{captchaKind === "alphanumeric"
          ? "英數字"
          : "數字"}，{expiresIn === undefined
          ? "驗證碼約兩分鐘內有效。"
          : expired
            ? "驗證碼已過期，請重新取得。"
            : `剩餘 ${expiresIn} 秒。`}
      </p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <img
          src={captchaImage}
          alt={`${connectorCatalog[connectorId].title}圖形驗證碼`}
          class="h-[70px] w-[200px] shrink-0 rounded border border-ink/25 bg-card object-fill shadow-sm"
        />
        <Input
          class="min-w-40 flex-1"
          inputmode={captchaKind === "alphanumeric" ? "text" : "numeric"}
          maxlength={digitCount}
          placeholder={`${digitCount} 位${captchaKind === "alphanumeric" ? "英數字" : "數字"}驗證碼`}
          bind:value={captcha}
        />
        <Button
          size="sm"
          disabled={operationPending ||
            expired ||
            (connectorId === "nextbank" &&
              (captcha?.trim().length ?? 0) !== digitCount)}
          onclick={onVerify}
          ><RefreshCw class="size-4" />{verifying
            ? "同步中…"
            : "驗證並同步"}</Button
        >
        <Button
          size="sm"
          variant="outline"
          disabled={operationPending}
          onclick={onRefresh}>換一張</Button
        >
      </div>
    </div>
  {/if}
{/snippet}

{#if connectorId === "nextbank"}
  {@render captchaPanel()}
{/if}

<details
  class="mt-3 rounded-md border border-ink/10 bg-paper text-sm text-ink/70"
>
  <summary class="cursor-pointer select-none px-3 py-2 font-medium text-ink/80"
    >使用說明</summary
  >
  <ol class="list-decimal space-y-1.5 px-3 pb-3 pt-1 pl-8">
    <li>先儲存登入憑證；機密欄位只會加密保存，不會重新顯示。</li>
    {#each guide as item (item)}<li>{item}</li>{/each}
  </ol>
</details>

{#if connectorId !== "nextbank"}
  {@render captchaPanel()}
{/if}
