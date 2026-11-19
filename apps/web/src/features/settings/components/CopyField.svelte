<script lang="ts">
  import { Check, Copy } from "@lucide/svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Icon from "@/shared/ui/Icon.svelte";

  let {
    text,
    label,
    mono = true,
  }: {
    text: string;
    /** 用於按鈕的無障礙名稱，例如「新增指令」。 */
    label: string;
    mono?: boolean;
  } = $props();

  let status = $state<"idle" | "copied" | "error">("idle");
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    clearTimeout(resetTimer);
    try {
      await navigator.clipboard.writeText(text);
      status = "copied";
      resetTimer = setTimeout(() => (status = "idle"), 2000);
    } catch {
      status = "error";
    }
  }

  $effect(() => () => clearTimeout(resetTimer));
</script>

<div class="grid min-w-0 gap-1">
  <div
    class="flex min-w-0 items-start gap-1 rounded-lg border border-border bg-muted/50 py-1 pl-3 pr-1"
  >
    <!-- 剪貼簿不可用時，點選文字即可全選後手動複製。 -->
    {#if mono}
      <!-- 指令以空白為斷點，避免在 --url 等連字號處斷行；過長的網址才在內部換行。 -->
      <code class="min-w-0 flex-1 select-all py-2 font-mono text-sm leading-6"
        >{#each text.split(" ") as token, index (index)}{index ? " " : ""}<span
            class="inline-block max-w-full [overflow-wrap:anywhere]"
            >{token}</span
          >{/each}</code
      >
    {:else}
      <p
        class="min-w-0 flex-1 select-all whitespace-pre-wrap py-2 text-sm leading-6 [overflow-wrap:anywhere]"
      >
        {text}
      </p>
    {/if}
    <Button
      variant="ghost"
      size="icon"
      aria-label={status === "copied" ? `已複製${label}` : `複製${label}`}
      title={`複製${label}`}
      onclick={copy}
    >
      <Icon
        icon={status === "copied" ? Check : Copy}
        class={status === "copied" ? "text-moss" : ""}
      />
    </Button>
  </div>
  <p
    role="status"
    aria-live="polite"
    class={status === "error" ? "text-sm text-coral" : "sr-only"}
  >
    {#if status === "error"}
      無法自動複製，請點選文字全選後手動複製。
    {:else if status === "copied"}
      已複製{label}
    {/if}
  </p>
</div>
