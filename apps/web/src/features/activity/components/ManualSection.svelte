<script lang="ts">
  // 活動明細「活動設定」裡手動記錄的編輯／刪除列。
  // 編輯開 ManualActivityDialog（狀態由 onEdit 交回頁面）；刪除先二次確認再 DELETE。
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import type { ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import Button from "@/shared/ui/Button.svelte";
  import type { ActivityItem } from "../model/types";

  let {
    api,
    item,
    onEdit,
    closeDetail,
    notify,
  }: {
    api: ApiClient;
    item: ActivityItem;
    onEdit: (item: ActivityItem) => void;
    /** 刪除成功後關閉活動明細。 */
    closeDetail: () => void;
    notify: (message: string) => void;
  } = $props();

  const qc = useQueryClient();
  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) =>
      api.delete(`/api/activity/manual/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.bank });
      closeDetail();
      notify("手動記錄已刪除");
    },
    onError: () => notify("刪除失敗，請再試一次。"),
  }));
  let confirming = $state(false);
  // 換看另一筆活動時，二次確認從頭開始（只看 id，資料重抓換了物件不會重置）。
  const itemId = $derived(item.id);
  $effect.pre(() => {
    void itemId;
    confirming = false;
  });
</script>

<div class="flex items-center justify-between gap-4 py-4">
  <div class="min-w-0">
    <p class="font-semibold">手動記錄</p>
    <p class="mt-1 text-caption text-subtle">可修改內容或刪除這筆記錄</p>
  </div>
  <div class="flex shrink-0 gap-2">
    <Button class="h-11" variant="outline" onclick={() => onEdit(item)}
      >編輯</Button
    >
    {#if !confirming}
      <Button
        class="h-11"
        variant="secondary"
        onclick={() => (confirming = true)}>刪除</Button
      >
    {:else}
      <Button
        class="h-11"
        disabled={deleteMutation.isPending}
        variant="destructive"
        onclick={() => deleteMutation.mutate(item.id)}
        >{deleteMutation.isPending ? "刪除中…" : "確定刪除"}</Button
      >
    {/if}
  </div>
</div>
