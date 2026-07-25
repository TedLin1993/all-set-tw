<script lang="ts">
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { Pencil, Plus } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import CardHeader from "@/shared/ui/CardHeader.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Badge from "@/shared/ui/Badge.svelte";
  import Checkbox from "@/shared/ui/Checkbox.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import Switch from "@/shared/ui/Switch.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { messageFromError } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import {
    classificationCategoriesQuery,
    classificationRulesQuery,
  } from "@/data/classification/queries";
  import type {
    ClassificationCategoryRow,
    ClassificationRuleRow,
  } from "@/data/classification/types";

  type RuleOperator = "contains" | "equals" | "starts_with" | "regex";
  type EditableRule = {
    id: string;
    categoryId: string;
    pattern: string;
    operator: RuleOperator;
    excludedFromCalculation: boolean;
  };

  let { api }: { api: ApiClient } = $props();

  const operatorLabels: Record<string, string> = {
    contains: "包含",
    equals: "完全等於",
    starts_with: "開頭為",
    regex: "符合正規表示式",
  };
  const rules = createQuery(classificationRulesQuery(() => api));
  const categories = createQuery(classificationCategoriesQuery(() => api));
  const qc = useQueryClient();
  const categoryLabels = $derived(
    Object.fromEntries(
      ($categories.data ?? []).map((category) => [category.id, category.label]),
    ),
  );
  let newRule = $state({
    categoryId: "food",
    pattern: "",
    operator: "contains",
    excludedFromCalculation: false,
  });
  let showCategoryForm = $state(false);
  let categoryName = $state("");
  let editingRule = $state<EditableRule | undefined>();

  function startEditing(rule: ClassificationRuleRow) {
    editingRule = {
      id: rule.id,
      categoryId: rule.categoryId,
      pattern: rule.pattern,
      operator: rule.operator as RuleOperator,
      excludedFromCalculation: rule.excludedFromCalculation,
    };
  }

  function invalidateRuleResults() {
    qc.invalidateQueries({ queryKey: queryKeys.classificationRules });
    qc.invalidateQueries({ queryKey: queryKeys.bank });
  }

  const addCategory = createMutation({
    mutationFn: () =>
      api.post<ClassificationCategoryRow>("/api/classification/categories", {
        label: categoryName,
      }),
    onSuccess: (category) => {
      qc.invalidateQueries({ queryKey: queryKeys.classificationCategories });
      newRule.categoryId = category.id;
      categoryName = "";
      showCategoryForm = false;
    },
  });
  const add = createMutation({
    mutationFn: () =>
      api.post("/api/classification/rules", {
        ...newRule,
        targetType: "bank_transaction",
        field: "any_text",
        priority: 200,
      }),
    onSuccess: () => {
      invalidateRuleResults();
      newRule.pattern = "";
      newRule.excludedFromCalculation = false;
    },
  });
  const toggle = createMutation({
    mutationFn: (payload: { id: string; enabled: boolean }) =>
      api.put(`/api/classification/rules/${payload.id}`, {
        enabled: payload.enabled,
      }),
    onSuccess: invalidateRuleResults,
  });
  const update = createMutation({
    mutationFn: (rule: EditableRule) =>
      api.put(`/api/classification/rules/${rule.id}`, {
        categoryId: rule.categoryId,
        pattern: rule.pattern,
        operator: rule.operator,
        excludedFromCalculation: rule.excludedFromCalculation,
      }),
    onSuccess: () => {
      invalidateRuleResults();
      editingRule = undefined;
    },
  });
  const remove = createMutation({
    mutationFn: (id: string) => api.delete(`/api/classification/rules/${id}`),
    onSuccess: invalidateRuleResults,
  });
</script>

<Card>
  <CardHeader class="gap-4 sm:flex-row sm:items-start sm:justify-between">
    <div>
      <h2 class="text-lg font-semibold">分類規則</h2>
      <p class="text-sm text-muted-foreground">
        讓銀行交易依條件自動分類，也可選擇不計入收支
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        aria-expanded={showCategoryForm}
        onclick={() => (showCategoryForm = !showCategoryForm)}
      >
        <Plus class="size-4" />新增分類
      </Button>
      <Badge class="text-sm" variant="secondary"
        >{$rules.data?.length ?? 0} 條</Badge
      >
    </div>
  </CardHeader>
  <CardContent>
    {#if showCategoryForm}
      <form
        class="mb-4 grid gap-3 rounded-lg border border-border bg-background p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end"
        onsubmit={(event) => {
          event.preventDefault();
          if (categoryName.trim()) $addCategory.mutate();
        }}
      >
        <label class="grid gap-1.5 text-sm font-medium">
          分類名稱
          <Input
            maxlength="24"
            placeholder="例如：寵物、旅遊"
            bind:value={categoryName}
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          disabled={!categoryName.trim() || $addCategory.isPending}
        >
          {$addCategory.isPending ? "新增中…" : "儲存分類"}
        </Button>
        <Button
          variant="ghost"
          onclick={() => {
            showCategoryForm = false;
            categoryName = "";
          }}>取消</Button
        >
        {#if $addCategory.isError}
          <p class="text-sm text-destructive sm:col-span-3" role="alert">
            {messageFromError($addCategory.error)}
          </p>
        {/if}
      </form>
    {/if}

    <div
      class="mb-4 overflow-hidden rounded-lg border border-border bg-muted/40"
    >
      <div
        class="grid gap-3 p-4 md:grid-cols-[minmax(0,140px)_minmax(0,140px)_minmax(0,1fr)]"
      >
        <label class="grid gap-1.5 text-sm font-medium">
          分類
          <Select bind:value={newRule.categoryId}>
            {#each $categories.data ?? [] as category (category.id)}
              <option value={category.id}>{category.label}</option>
            {/each}
          </Select>
        </label>
        <label class="grid gap-1.5 text-sm font-medium">
          條件
          <Select bind:value={newRule.operator}>
            <option value="contains">包含</option>
            <option value="equals">完全等於</option>
            <option value="starts_with">開頭為</option>
          </Select>
        </label>
        <label class="grid gap-1.5 text-sm font-medium">
          關鍵字
          <Input placeholder="例如：卡費" bind:value={newRule.pattern} />
        </label>
      </div>
      <div
        class="flex flex-col gap-3 border-t border-border bg-background px-4 py-3 sm:flex-row sm:items-center"
      >
        <div class="flex min-w-0 flex-1 items-center gap-3">
          <Switch
            aria-label="符合規則時不計入收支"
            bind:checked={newRule.excludedFromCalculation}
          />
          <div class="min-w-0">
            <p class="text-sm font-semibold">符合時不計入收支</p>
            <p class="text-sm text-muted-foreground">
              仍保留所選分類，只排除圖表與收支加總。
            </p>
          </div>
        </div>
        <Button
          class="w-full sm:w-auto"
          variant="primary"
          disabled={!newRule.pattern.trim() || $add.isPending}
          onclick={() => $add.mutate()}
        >
          {$add.isPending ? "新增中…" : "新增規則"}
        </Button>
      </div>
    </div>

    {#if $categories.isError || $rules.isError}
      <p class="py-3 text-sm text-destructive" role="alert">
        無法載入分類設定，請稍後再試。
      </p>
    {:else if $rules.isPending}
      <p class="py-3 text-sm text-muted-foreground">載入分類規則中…</p>
    {:else if ($rules.data?.length ?? 0) === 0}
      <p class="py-3 text-sm text-muted-foreground">目前還沒有分類規則。</p>
    {:else}
      <div class="divide-y divide-border">
        {#each $rules.data ?? [] as rule (rule.id)}
          <div class="py-3.5 text-sm">
            {#if editingRule && editingRule.id === rule.id}
              <form
                class="rounded-lg border border-border bg-muted/30 p-4"
                onsubmit={(event) => {
                  event.preventDefault();
                  if (editingRule?.pattern.trim()) $update.mutate(editingRule);
                }}
              >
                <div
                  class="grid gap-3 md:grid-cols-[minmax(0,140px)_minmax(0,140px)_minmax(0,1fr)]"
                >
                  <label class="grid gap-1.5 font-medium">
                    分類
                    <Select bind:value={editingRule.categoryId}>
                      {#each $categories.data ?? [] as category (category.id)}
                        <option value={category.id}>{category.label}</option>
                      {/each}
                    </Select>
                  </label>
                  <label class="grid gap-1.5 font-medium">
                    條件
                    <Select bind:value={editingRule.operator}>
                      <option value="contains">包含</option>
                      <option value="equals">完全等於</option>
                      <option value="starts_with">開頭為</option>
                      <option value="regex">符合正規表示式</option>
                    </Select>
                  </label>
                  <label class="grid gap-1.5 font-medium">
                    關鍵字
                    <Input bind:value={editingRule.pattern} />
                  </label>
                </div>
                <div
                  class="mt-4 flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center"
                >
                  <div class="flex min-w-0 flex-1 items-center gap-3">
                    <Switch
                      aria-label="編輯規則是否不計入收支"
                      bind:checked={editingRule.excludedFromCalculation}
                    />
                    <div class="min-w-0">
                      <p class="font-semibold">符合時不計入收支</p>
                      <p class="text-sm text-muted-foreground">
                        仍保留所選分類，只排除圖表與收支加總。
                      </p>
                    </div>
                  </div>
                  <div class="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      disabled={$update.isPending}
                      onclick={() => (editingRule = undefined)}>取消</Button
                    >
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={!editingRule.pattern.trim() ||
                        $update.isPending}
                    >
                      {$update.isPending ? "儲存中…" : "儲存變更"}
                    </Button>
                  </div>
                </div>
              </form>
            {:else}
              <div class="flex items-start gap-3">
                <Checkbox
                  aria-label={`${rule.enabled ? "停用" : "啟用"}${categoryLabels[rule.categoryId] ?? rule.categoryId}規則`}
                  class="mt-1"
                  checked={rule.enabled}
                  disabled={rule.isSystem}
                  onchange={(event: Event) =>
                    $toggle.mutate({
                      id: rule.id,
                      enabled: (event.currentTarget as HTMLInputElement)
                        .checked,
                    })}
                />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <Badge class="text-sm" variant="outline">
                      {categoryLabels[rule.categoryId] ?? rule.categoryId}
                    </Badge>
                    {#if rule.excludedFromCalculation}
                      <Badge
                        class="border-transparent bg-coral/10 text-coral text-sm"
                      >
                        不計入收支
                      </Badge>
                    {/if}
                    {#if rule.isSystem}
                      <Badge class="text-sm" variant="secondary">內建</Badge>
                    {/if}
                  </div>
                  <p class="mt-1.5 break-words text-foreground/80">
                    {operatorLabels[rule.operator] ??
                      rule.operator}「{rule.pattern}」
                  </p>
                </div>
                {#if !rule.isSystem}
                  <div class="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={$update.isPending || $remove.isPending}
                      onclick={() => startEditing(rule)}
                    >
                      <Pencil class="size-4" />編輯
                    </Button>
                    <Button
                      class="text-destructive hover:text-destructive"
                      size="sm"
                      variant="ghost"
                      disabled={$remove.isPending &&
                        $remove.variables === rule.id}
                      onclick={() => $remove.mutate(rule.id)}>刪除</Button
                    >
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if $add.isError || $toggle.isError || $update.isError || $remove.isError}
      <p class="mt-3 text-sm text-destructive" role="alert">
        {messageFromError(
          $add.error ?? $toggle.error ?? $update.error ?? $remove.error,
        )}
      </p>
    {/if}
  </CardContent>
</Card>
