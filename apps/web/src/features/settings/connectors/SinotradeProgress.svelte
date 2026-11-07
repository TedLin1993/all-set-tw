<script lang="ts">
  import { CircleCheckBig, LoaderCircle } from "@lucide/svelte";

  let {
    states,
    syncing = false,
    hint = "",
    showHelp = true,
  }: {
    /** 依序為：登入憑證、新理財網、豐存股、首次同步。 */
    states: Array<"done" | "current" | "todo">;
    syncing?: boolean;
    hint?: string;
    showHelp?: boolean;
  } = $props();

  const labels = ["儲存登入憑證", "驗證新理財網", "驗證豐存股", "首次同步"];
  const tones = {
    done: "bg-moss/[0.07] text-moss",
    current: "bg-steel/[0.07] text-steel",
    todo: "text-ink/55",
  };
</script>

<ol
  aria-label="永豐證券連線進度"
  class="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-ink/10 bg-ink/10 sm:grid-cols-4"
>
  {#each labels as label, index (label)}
    {@const state = states[index] ?? "todo"}
    <li
      aria-current={state === "current" ? "step" : undefined}
      class="bg-paper"
    >
      <div class={`flex items-center gap-3 px-3 py-3 ${tones[state]}`}>
        <span
          class="grid size-7 shrink-0 place-items-center rounded-full border border-current/20 text-sm font-bold"
        >
          {#if state === "done"}
            <CircleCheckBig class="size-4" />
          {:else if state === "current" && index === 3 && syncing}
            <LoaderCircle class="size-4 animate-spin" />
          {:else}
            {index + 1}
          {/if}
        </span>
        <span class="text-sm font-semibold">{label}</span>
      </div>
    </li>
  {/each}
</ol>
{#if hint}
  <p class="mt-3 text-sm leading-relaxed text-muted-foreground">{hint}</p>
{/if}

{#if showHelp}
  <details
    class="mt-3 rounded-md border border-ink/10 bg-paper text-sm text-ink/70"
  >
    <summary
      class="cursor-pointer select-none px-3 py-2 font-medium text-ink/80"
      >使用說明</summary
    >
    <ol class="list-decimal space-y-1.5 px-3 pb-3 pt-1 pl-8">
      <li>填入身分證字號與證券網路密碼，按「連線並同步」；帳密會加密保存。</li>
      <li>
        台股與美股在「新理財網」，豐存股是另一個獨立網站；兩邊的憑證各自管理，所以各驗證一次。
      </li>
      <li>
        每個平台依官方要求，依序輸入出生年月日、選擇手機或 Email
        收取一次性驗證碼，並閱讀、同意憑證作業條款；載入憑證與完成連線這類不需輸入的步驟會自動接續。
      </li>
      <li>
        寄送驗證碼與同意條款一定由你按下按鈕；重新整理或排程不會代你操作。
      </li>
      <li>
        兩個平台都完成後會自動進行首次同步，日後通常不需重新驗證。每個平台有 10
        分鐘完成驗證，逾時可重新開始。
      </li>
    </ol>
  </details>
{/if}
