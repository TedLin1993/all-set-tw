<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "@/shared/utils/cn";
  let {
    children,
    class: className = "",
    variant = "default",
    size = "default",
    disabled = false,
    type = "button",
    ...rest
  }: {
    children?: Snippet;
    class?: string;
    variant?:
      | "default"
      | "primary"
      | "secondary"
      | "outline"
      | "ghost"
      | "link"
      | "destructive";
    size?: "sm" | "default" | "lg" | "touch" | "icon";
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    [key: string]: unknown;
  } = $props();
  const variants = {
    default: "bg-inverse text-white shadow-xs hover:bg-inverse/90",
    primary: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
    secondary:
      "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
    outline:
      "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
    ghost: "text-foreground/70 hover:bg-accent hover:text-accent-foreground",
    link: "text-primary underline-offset-4 hover:underline",
    destructive:
      "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
  };
  const sizes = {
    sm: "h-9 rounded-md px-3 [&_svg]:size-4",
    default: "h-10 px-4 py-2 [&_svg]:size-4",
    lg: "h-11 rounded-md px-8 [&_svg]:size-5",
    touch: "min-h-11 px-4 [&_svg]:size-5",
    icon: "size-10 p-0 [&_svg]:size-4",
  };
</script>

<button
  {...rest}
  {disabled}
  {type}
  class={cn(
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    variants[variant],
    sizes[size],
    className,
  )}
>
  {@render children?.()}
</button>
