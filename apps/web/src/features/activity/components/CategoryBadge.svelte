<script lang="ts">
  import Badge from "@/shared/ui/Badge.svelte";
  import { cn } from "@/shared/utils/cn";
  import { activityCategoryColor } from "../model/chart";

  let {
    label,
    categoryId,
    class: className = "",
  }: {
    label: string;
    categoryId: string | undefined;
    class?: string;
  } = $props();
</script>

<Badge
  variant="secondary"
  class={cn("min-w-0 max-w-full gap-1.5 pl-2", className)}
  ><span
    aria-hidden="true"
    class="size-1.5 shrink-0 rounded-full"
    style={`background-color:${activityCategoryColor(categoryId)}`}
  ></span><span class="truncate" title={label}>{label}</span></Badge
>
