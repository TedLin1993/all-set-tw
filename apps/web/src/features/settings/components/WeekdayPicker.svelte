<script lang="ts">
  let {
    value,
    disabled = false,
    onchange,
  }: {
    value: number[];
    disabled?: boolean;
    onchange: (days: number[]) => void;
  } = $props();
  const labels = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
</script>

<fieldset class="grid gap-2" {disabled}>
  <legend class="mb-2 text-sm font-medium">執行日（可複選）</legend>
  <div class="flex flex-wrap gap-2">
    {#each labels as label, day}
      <label
        class="flex items-center gap-1 rounded-md border border-border px-2 py-2 text-sm"
      >
        <input
          type="checkbox"
          checked={value.includes(day)}
          disabled={disabled || (value.length === 1 && value.includes(day))}
          onchange={() =>
            onchange(
              value.includes(day)
                ? value.filter((item) => item !== day)
                : [...value, day].sort((a, b) => a - b),
            )}
        />
        {label}
      </label>
    {/each}
  </div>
</fieldset>
