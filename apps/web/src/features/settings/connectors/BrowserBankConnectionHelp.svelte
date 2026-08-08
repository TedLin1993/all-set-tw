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
    onVerify,
    onRefresh,
  }: {
    bankName: "永豐" | "台新" | "王道";
    captchaImage: string;
    captcha?: string;
    digitCount: number;
    captchaKind?: "numeric" | "alphanumeric";
    preparing: boolean;
    verifying: boolean;
    syncing?: boolean;
    onVerify: () => void;
    onRefresh: () => void;
  } = $props();

  const operationPending = $derived(preparing || verifying || syncing);
</script>

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

{#if captchaImage}
  <div class="mt-3 rounded-md border border-ink/10 bg-paper p-3">
    <p class="text-sm font-medium text-ink/80">
      請輸入圖片中的 {digitCount} 位{captchaKind === "alphanumeric"
        ? "英數字"
        : "數字"}，驗證碼約兩分鐘內有效。
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
      <Button size="sm" disabled={operationPending} onclick={onVerify}
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
