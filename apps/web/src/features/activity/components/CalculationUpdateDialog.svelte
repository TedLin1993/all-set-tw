<script lang="ts">
  import Button from "@/shared/ui/Button.svelte";
  import Checkbox from "@/shared/ui/Checkbox.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import type {
    CalculationUpdateInput,
    PendingCalculationUpdate,
  } from "../model/types";

  let {
    update = $bindable(),
    categoryOptions,
    matchCount,
    submitting,
    failed,
    onCancel,
    onSubmit,
  }: {
    update: PendingCalculationUpdate;
    categoryOptions: { id: string; label: string }[];
    matchCount: number;
    submitting: boolean;
    failed: boolean;
    onCancel: () => void;
    onSubmit: (input: CalculationUpdateInput) => void;
  } = $props();

  const updatesExistingRule = $derived(
    update.item.classificationSource === "user_rule" &&
      Boolean(update.item.classificationRuleId),
  );
</script>

<div
  aria-labelledby="calculation-update-title"
  aria-modal="true"
  class="fixed inset-0 z-[75] flex items-end bg-ink/45 md:items-center md:justify-center md:p-6"
  role="dialog"
>
  <div
    class="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl md:max-w-lg md:rounded-2xl md:p-6"
  >
    <h2 class="text-xl font-semibold" id="calculation-update-title">
      排除統計計算
    </h2>
    <p class="mt-1 text-sm text-ink/50">
      將保留「{update.item.title}」，但不計入收支與圖表。
    </p>

    <label class="mt-5 grid gap-2 text-sm font-semibold">
      分類
      <Select bind:value={update.categoryId}>
        {#each categoryOptions as category (category.id)}
          <option value={category.id}>{category.label}</option>
        {/each}
      </Select>
    </label>

    <label
      class="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-ink/10 bg-paper p-4"
    >
      <Checkbox
        class="mt-1"
        checked={update.applyRule}
        onchange={(event: Event) =>
          (update.applyRule = (
            event.currentTarget as HTMLInputElement
          ).checked)}
      />
      <span>
        <span class="block font-semibold">
          {updatesExistingRule ? "同時修改目前分類規則" : "同時新增分類規則"}
        </span>
        <span class="mt-1 block text-xs text-ink/50">
          {updatesExistingRule
            ? "之後符合目前規則的活動也會使用所選分類並排除計算。"
            : "之後符合新規則的活動也會使用所選分類並排除計算。"}
        </span>
      </span>
    </label>

    {#if update.applyRule && !updatesExistingRule}
      <div
        class="mt-4 grid gap-3 rounded-xl border border-steel/20 bg-steel/5 p-4"
      >
        <Select bind:value={update.operator}>
          <option value="contains">交易文字包含</option>
          <option value="equals">交易文字完全等於</option>
        </Select>
        <Input bind:value={update.pattern} />
        <p class="text-xs font-semibold text-steel">
          目前載入的活動中有 {matchCount} 筆符合
        </p>
      </div>
    {:else if update.applyRule}
      <p
        class="mt-4 rounded-xl border border-steel/20 bg-steel/5 p-4 text-xs font-medium text-steel"
      >
        這會修改既有的使用者規則，並影響所有符合該規則的活動。
      </p>
    {/if}

    <div class="mt-5 grid grid-cols-2 gap-3">
      <Button variant="secondary" onclick={onCancel}>取消</Button>
      <Button
        disabled={submitting ||
          (update.applyRule && !updatesExistingRule && !update.pattern.trim())}
        onclick={() =>
          onSubmit({
            transactionId: update.item.transactionId!,
            categoryId: update.categoryId,
            originalCategoryId: update.item.categoryId ?? "other",
            applyRule: update.applyRule,
            ruleId: updatesExistingRule
              ? update.item.classificationRuleId
              : undefined,
            pattern: update.pattern,
            operator: update.operator,
          })}
      >
        {submitting ? "更新中…" : "確認排除"}
      </Button>
    </div>

    {#if failed}
      <p class="mt-3 text-sm text-coral">
        無法完成更新，請確認目前設定後再試一次。
      </p>
    {/if}
  </div>
</div>
