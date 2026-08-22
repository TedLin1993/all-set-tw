<script lang="ts">
  import { CircleCheckBig } from "@lucide/svelte";

  let {
    step,
    connectionReady,
    source,
  }: {
    step: "credentials" | "email" | "sms" | "complete";
    connectionReady: boolean;
    source: "tdcc" | "cathaybk";
  } = $props();

  const sourceName = $derived(source === "tdcc" ? "集保" : "國泰世華");
</script>

<div
  class="mt-4 grid overflow-hidden rounded-xl border border-ink/10 bg-paper sm:grid-cols-3"
  aria-label={`${sourceName}連線進度`}
>
  <div
    class={`flex items-center gap-3 px-3 py-3 ${step === "credentials" && !connectionReady ? "bg-steel/[0.07] text-steel" : "text-ink/55"}`}
  >
    <span
      class="grid size-7 shrink-0 place-items-center rounded-full border border-current/20 text-sm font-bold"
      >1</span
    >
    <span class="text-sm font-semibold"
      >{source === "tdcc" ? "確認集保帳密" : "確認網銀帳密"}</span
    >
  </div>
  <div
    class={`flex items-center gap-3 border-t border-ink/10 px-3 py-3 sm:border-l sm:border-t-0 ${step === "email" || step === "sms" ? "bg-steel/[0.07] text-steel" : "text-ink/55"}`}
  >
    <span
      class="grid size-7 shrink-0 place-items-center rounded-full border border-current/20 text-sm font-bold"
      >2</span
    >
    <span class="text-sm font-semibold">驗證這台裝置</span>
  </div>
  <div
    class={`flex items-center gap-3 border-t border-ink/10 px-3 py-3 sm:border-l sm:border-t-0 ${connectionReady || step === "complete" ? "bg-moss/[0.07] text-moss" : "text-ink/55"}`}
  >
    <span
      class="grid size-7 shrink-0 place-items-center rounded-full border border-current/20 text-sm font-bold"
      >{#if connectionReady || step === "complete"}<CircleCheckBig
          class="size-4"
        />{:else}3{/if}</span
    >
    <span class="text-sm font-semibold">完成首次同步</span>
  </div>
</div>

<details
  class="mt-3 rounded-md border border-ink/10 bg-paper text-sm text-ink/70"
>
  <summary class="cursor-pointer select-none px-3 py-2 font-medium text-ink/80"
    >使用說明</summary
  >
  <ol class="list-decimal space-y-1.5 px-3 pb-3 pt-1 pl-8">
    {#if source === "tdcc"}
      <li>先在手機下載並登入「集保e存摺」，確認可看到股票與基金資料。</li>
      <li>填入身分證字號與集保 App 密碼，再按「連線並取得驗證碼」。</li>
      <li>系統只會在集保要求時寄出 Email；部分帳號還需要簡訊驗證。</li>
      <li>驗證成功後會自動執行首次同步，日後通常不需重新輸入驗證碼。</li>
    {:else}
      <li>先儲存國泰世華網路銀行帳密，再按上方的「同步」。</li>
      <li>首次同步若銀行要求額外驗證，可選擇 Email 或簡訊接收驗證碼。</li>
      <li>驗證成功後會加入「ALL SET 同步」信任裝置並完成首次同步。</li>
      <li>日後通常不需重新輸入驗證碼；銀行仍可能視安全狀態要求重新驗證。</li>
    {/if}
  </ol>
</details>
