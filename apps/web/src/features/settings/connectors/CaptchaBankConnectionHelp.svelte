<script lang="ts">
  import { RefreshCw } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";

  let {
    bankName,
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
    bankName:
      | "永豐"
      | "台新"
      | "王道"
      | "華南"
      | "第一銀行"
      | "凱基"
      | "兆豐"
      | "將來"
      | "樂天"
      | "台北富邦"
      | "遠東商銀";
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
          alt={`${bankName}圖形驗證碼`}
          class="h-[70px] w-[200px] shrink-0 rounded border border-ink/25 bg-white object-fill shadow-sm"
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
            (bankName === "將來" &&
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

{#if bankName === "將來"}
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
    {#if bankName === "王道"}
      <li>系統透過王道 App API 讀取資料，並自動辨識四位英數驗證碼。</li>
      <li>若自動辨識失敗，可取得圖片後改用人工輸入。</li>
      <li>
        手動與排程同步必要時都會接管其他登入中的裝置；官方 App
        可能需要重新登入。
      </li>
    {:else if bankName === "將來"}
      <li>
        按「同步帳戶」即可開始。若驗證碼辨識失敗，會自動顯示新圖片；填入後按「驗證並同步」。
      </li>
      <li>每次查詢後會登出，不接管其他登入。同步前請先結束銀行 App 操作。</li>
      <li>支援存款與口袋，不含美股及基金持倉。</li>
    {:else if bankName === "凱基"}
      <li>每次同步會自動辨識 6 位數字驗證碼；連續失敗後可改用人工輸入。</li>
      <li>
        凱基同一帳號僅允許單一登入：同步會登出行動銀行 App，完成後自動登出網銀。
      </li>
      <li>帳密被拒絕時會立即停止、不會重試，以免累積錯誤次數導致停權。</li>
    {:else if bankName === "兆豐"}
      <li>系統透過兆豐 App API 讀取資料，每次登入需要五位數字驗證碼。</li>
      <li>系統會先自動辨識；若辨識失敗，可取得圖片後改用人工輸入。</li>
      <li>一般帳密登入不需要快速登入或裝置綁定。</li>
    {:else if bankName === "台北富邦"}
      <li>每次同步會自動辨識 6 位數字驗證碼；連續失敗後可改用人工輸入。</li>
      <li>
        非信任裝置登入需要雙重驗證：手動同步會請銀行寄送簡訊／Email
        驗證碼，排程同步不會寄送，只會標記需要處理。
      </li>
      <li>
        若已有其他登入中的網銀，系統不會接管，會停止同步；完成後自動登出網銀。
      </li>
      <li>帳密被拒絕時會立即停止、不會重試，以免累積錯誤次數導致鎖定。</li>
    {:else if bankName === "遠東商銀"}
      <li>每次同步會自動辨識 6 位數字驗證碼；連續失敗後可改用人工輸入。</li>
      <li>
        驗證碼會先由網銀頁面檢核，錯誤時不會送出密碼；帳密被拒絕時會立即停止，以免連續錯誤三次遭停用。
      </li>
      <li>
        若出現年度密碼變更提醒，系統只會選擇「下次登入再變更」，不會變更密碼；同步完成後自動登出網銀。
      </li>
    {:else}
      <li>首次或銀行 session 失效時，系統會自動辨識圖形驗證碼並登入。</li>
      <li>每次自動登入最多嘗試三張驗證碼，連續失敗後可改用人工輸入。</li>
    {/if}
    {#if bankName === "台新"}
      <li>
        台新可能會讓新的自動登入取代當下正在使用的網銀
        session，建議先完成其他網銀操作。
      </li>
    {/if}
  </ol>
</details>

{#if bankName !== "將來"}
  {@render captchaPanel()}
{/if}
