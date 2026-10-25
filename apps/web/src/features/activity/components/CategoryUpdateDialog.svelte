<script lang="ts">
  import Button from "@/shared/ui/Button.svelte";
  import Checkbox from "@/shared/ui/Checkbox.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import type {
    CategoryUpdateInput,
    PendingCategoryUpdate,
  } from "../model/types";

  let {
    update,
    categories,
    matchCount,
    submitting,
    failed,
    onCancel,
    onSubmit,
  }: {
    update: PendingCategoryUpdate;
    categories: Record<string, string>;
    matchCount: number;
    submitting: boolean;
    failed: boolean;
    onCancel: () => void;
    onSubmit: (input: CategoryUpdateInput) => void;
  } = $props();
</script>

<div
  aria-modal="true"
  class="fixed inset-0 z-[70] flex items-end bg-inverse/45 md:items-center md:justify-center md:p-6"
  role="dialog"
>
  <div
    class="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-card p-5 shadow-2xl md:max-w-lg md:rounded-2xl md:p-6"
  >
    <h2 class="text-xl font-semibold">更新活動分類</h2>
    <p class="mt-1 text-sm text-subtle">
      {update.item.title} → {categories[update.categoryId] ?? update.categoryId}
    </p>
    <label
      class="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-ink/10 bg-paper p-4"
      ><Checkbox
        class="mt-1"
        checked={update.addRule}
        onchange={(event: Event) =>
          (update.addRule = (event.currentTarget as HTMLInputElement).checked)}
      /><span
        ><span class="block font-semibold">同時新增分類規則</span><span
          class="mt-1 block text-caption text-subtle"
          >符合規則的活動之後會自動套用。</span
        ></span
      ></label
    >
    {#if update.addRule}
      <div
        class="mt-4 grid gap-3 rounded-xl border border-steel/20 bg-steel/5 p-4"
      >
        <Select bind:value={update.operator}
          ><option value="contains">交易文字包含</option><option value="equals"
            >交易文字完全等於</option
          ></Select
        >
        <Input bind:value={update.pattern} />
        <p class="text-caption font-semibold text-steel">
          將更新 {matchCount} 筆過去活動
        </p>
      </div>
    {/if}
    <div class="mt-5 grid grid-cols-2 gap-3">
      <Button variant="secondary" onclick={onCancel}>取消</Button>
      <Button
        disabled={submitting || (update.addRule && !update.pattern.trim())}
        onclick={() =>
          onSubmit({
            transactionId: update.item.transactionId!,
            categoryId: update.categoryId,
            addRule: update.addRule,
            pattern: update.pattern,
            operator: update.operator,
          })}>{submitting ? "更新中…" : "更新分類"}</Button
      >
    </div>
    {#if failed}
      <p class="mt-3 text-sm text-coral">更新失敗。</p>
    {/if}
  </div>
</div>
