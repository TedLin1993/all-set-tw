<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "@/shared/utils/cn";
  let {
    children,
    class: className = "",
    ...rest
  }: {
    children?: Snippet;
    class?: string;
    [key: string]: unknown;
  } = $props();
</script>

<div
  {...rest}
  role="tablist"
  class={cn(
    "inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
    className,
  )}
>
  {@render children?.()}
</div>
