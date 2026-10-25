<script lang="ts">
  import { RefreshCw } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";

  let {
    captchaImage,
    captcha = $bindable(),
    preparing,
    verifying,
    onVerify,
    onRefresh,
  }: {
    captchaImage: string;
    captcha?: string;
    preparing: boolean;
    verifying: boolean;
    onVerify: () => void;
    onRefresh: () => void;
  } = $props();
</script>

<details
  class="mt-3 rounded-md border border-ink/10 bg-paper text-sm text-ink/70"
>
  <summary class="cursor-pointer select-none px-3 py-2 font-medium text-ink/80"
    >使用說明</summary
  >
  <ol class="list-decimal space-y-1.5 px-3 pb-3 pt-1 pl-8">
    <li>先儲存身分證字號／統編、行動／網路銀行使用者代碼與網路密碼。</li>
    <li>
      首次或銀行 session 失效時，系統會用 Gemma 4 自動辨識圖形驗證碼並登入。
    </li>
    <li>
      驗證成功後會加密保存
      session，並同步臺外幣活存帳戶、餘額與近三個月交易，以及信用卡總覽、近期帳單與未出帳消費。
    </li>
    <li>每次自動登入最多嘗試三張不同驗證碼；連續失敗後可改用人工輸入。</li>
  </ol>
</details>

{#if captchaImage}
  <div class="mt-3 rounded-md border border-ink/10 bg-paper p-3">
    <p class="text-sm font-medium text-ink/80">
      請輸入圖片中的六位數字，驗證碼約兩分鐘內有效。
    </p>
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <img
        src={captchaImage}
        alt="永豐圖形驗證碼"
        class="h-[70px] w-[200px] shrink-0 rounded border border-ink/25 bg-card object-fill shadow-sm"
      />
      <Input
        class="min-w-40 flex-1"
        inputmode="numeric"
        maxlength="6"
        placeholder="六位數字驗證碼"
        bind:value={captcha}
      />
      <Button size="sm" disabled={verifying} onclick={onVerify}
        ><RefreshCw class="size-4" />{verifying
          ? "同步中…"
          : "驗證並同步"}</Button
      >
      <Button
        size="sm"
        variant="outline"
        disabled={preparing || verifying}
        onclick={onRefresh}>換一張</Button
      >
    </div>
  </div>
{/if}
