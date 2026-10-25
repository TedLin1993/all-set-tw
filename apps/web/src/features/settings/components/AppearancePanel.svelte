<script lang="ts">
  import Card from "@/shared/ui/Card.svelte";
  import CardContent from "@/shared/ui/CardContent.svelte";
  import type { ThemePreference } from "@/shared/theme/theme";
  import {
    setThemePreference,
    themeState,
  } from "@/shared/theme/theme-state.svelte";

  const options: { value: ThemePreference; label: string }[] = [
    { value: "system", label: "跟隨系統" },
    { value: "light", label: "淺色" },
    { value: "dark", label: "深色" },
  ];
</script>

<Card>
  <CardContent
    class="grid gap-4 pt-5 sm:flex sm:items-center sm:justify-between sm:p-6"
  >
    <div>
      <h3 id="appearance-heading" class="font-semibold">外觀</h3>
      <p class="mt-1 text-sm text-muted-foreground">
        只套用在這台裝置的瀏覽器。
      </p>
    </div>
    <div
      role="radiogroup"
      aria-labelledby="appearance-heading"
      class="grid h-11 grid-cols-3 gap-1 rounded-lg bg-ink/5 p-0.5 sm:w-72"
    >
      {#each options as option (option.value)}
        <button
          type="button"
          role="radio"
          aria-checked={themeState.preference === option.value}
          class={`h-10 cursor-pointer rounded-md px-2.5 text-sm font-semibold transition ${themeState.preference === option.value ? "bg-steel text-white" : "text-subtle hover:bg-ink/5 hover:text-ink"}`}
          onclick={() => setThemePreference(option.value)}
          >{option.label}</button
        >
      {/each}
    </div>
  </CardContent>
</Card>
