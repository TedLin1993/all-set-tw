<script lang="ts">
  import { tick } from "svelte";
  import { ChevronRight, PencilLine } from "@lucide/svelte";
  import { BANK_TRANSACTION_NOTE_MAX_LENGTH } from "@taiwan-fin-hub/shared";
  import Button from "@/shared/ui/Button.svelte";
  import Textarea from "@/shared/ui/Textarea.svelte";

  let {
    note,
    title,
    submitting,
    failed,
    onSave,
  }: {
    note?: string;
    title: string;
    submitting: boolean;
    failed: boolean;
    /** 儲存並等快取重新載入後才 resolve；失敗時 reject。 */
    onSave: (note: string) => Promise<unknown>;
  } = $props();

  const inputId = "activity-note-input";
  // 父層以活動 key 重建此元件，切換活動時不會殘留編輯狀態。
  let editing = $state(false);
  let draft = $state("");
  const saved = $derived(note ?? "");
  const trimmed = $derived(draft.trim());
  // 接近上限才顯示字數，平常保持安靜。
  const showCount = $derived(
    trimmed.length > BANK_TRANSACTION_NOTE_MAX_LENGTH * 0.8,
  );

  async function startEditing() {
    draft = saved;
    editing = true;
    await tick();
    document.getElementById(inputId)?.focus();
  }

  async function save() {
    try {
      await onSave(trimmed);
      editing = false;
    } catch {
      // 失敗訊息由 failed 顯示，保留草稿讓使用者重試。
    }
  }
</script>

{#if editing}<section class="border-b border-ink/10 py-5">
    <label class="grid gap-1" for={inputId}>
      <span class="text-base font-semibold">備註</span>
      <span class="text-caption text-subtle"
        >可用搜尋找到，AI 助理也能讀取。</span
      >
    </label>
    <Textarea
      aria-label={`${title} 的備註`}
      bind:value={draft}
      class="mt-3"
      id={inputId}
      maxlength={BANK_TRANSACTION_NOTE_MAX_LENGTH}
      placeholder="例如：代墊同事午餐、房租含管理費"
      rows={3}
    />
    <div class="mt-2 flex items-center justify-between gap-3">
      <p
        aria-live="polite"
        class={`text-caption ${failed ? "text-coral" : "text-subtle"}`}
      >
        {failed
          ? "儲存失敗，請稍後再試。"
          : showCount
            ? `${trimmed.length}／${BANK_TRANSACTION_NOTE_MAX_LENGTH}`
            : ""}
      </p>
      <div class="flex shrink-0 gap-2">
        <Button
          class="h-11"
          disabled={submitting}
          variant="ghost"
          onclick={() => (editing = false)}>取消</Button
        >
        <Button
          class="h-11"
          disabled={trimmed === saved || submitting}
          onclick={save}
          >{submitting
            ? "儲存中…"
            : trimmed || !saved
              ? "儲存"
              : "清除備註"}</Button
        >
      </div>
    </div>
  </section>{:else if saved}<section class="border-b border-ink/10 py-5">
    <div class="flex items-center justify-between gap-3">
      <h3 class="text-base font-semibold">備註</h3>
      <Button
        aria-label={`編輯 ${title} 的備註`}
        class="-mr-3 h-11 text-steel"
        variant="ghost"
        onclick={startEditing}>編輯</Button
      >
    </div>
    <p class="mt-1 whitespace-pre-wrap break-words">{saved}</p>
  </section>{:else}<div class="border-b border-ink/10 py-1">
    <button
      aria-label={`新增 ${title} 的備註`}
      class="flex min-h-12 w-full items-center gap-2 rounded-md text-left font-medium text-steel hover:bg-ink/3"
      onclick={startEditing}
      type="button"
      ><PencilLine class="size-4 shrink-0" /><span class="flex-1">新增備註</span
      ><ChevronRight class="size-4 shrink-0 text-subtle" /></button
    >
  </div>{/if}
