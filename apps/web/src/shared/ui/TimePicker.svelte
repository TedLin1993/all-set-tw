<script lang="ts">
  import { Popover } from "bits-ui";
  import { Check, ChevronDown, Clock3 } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Select from "./Select.svelte";

  let {
    value = $bindable("06:00"),
    open = $bindable(false),
    disabled = false,
    minuteStep = 10,
    onchange,
  }: {
    value?: string;
    open?: boolean;
    disabled?: boolean;
    minuteStep?: number;
    onchange?: (value: string) => void;
  } = $props();

  const hours = Array.from({ length: 24 }, (_, hour) =>
    String(hour).padStart(2, "0"),
  );
  const selectedHour = $derived(normalizeTime(value).split(":")[0]);
  const selectedMinute = $derived(normalizeTime(value).split(":")[1]);
  const minutes = $derived.by(() => {
    const safeStep = Math.min(30, Math.max(1, Math.floor(minuteStep)));
    const options = Array.from(
      { length: Math.ceil(60 / safeStep) },
      (_, index) => String(index * safeStep).padStart(2, "0"),
    ).filter((minute) => Number(minute) < 60);
    return [...new Set([...options, selectedMinute])].sort();
  });

  function normalizeTime(input: string) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(input);
    if (!match) return "06:00";
    const hour = Math.min(23, Math.max(0, Number(match[1])));
    const minute = Math.min(59, Math.max(0, Number(match[2])));
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function update(nextHour: string, nextMinute: string) {
    const nextValue = normalizeTime(`${nextHour}:${nextMinute}`);
    value = nextValue;
    onchange?.(nextValue);
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger {disabled}>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="outline"
        class="w-full justify-between px-3 font-normal"
        {disabled}
        aria-label={`選擇時間，目前 ${normalizeTime(value)}`}
      >
        <span class="flex items-center gap-2">
          <Clock3 />
          <span class="tabular-nums">{normalizeTime(value)}</span>
        </span>
        <ChevronDown class="text-muted-foreground" />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    align="start"
    sideOffset={6}
    class="w-64 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1">
        <p class="text-sm font-semibold">選擇同步時間</p>
        <p class="text-xs text-muted-foreground">時區：Asia/Taipei</p>
      </div>
      <div class="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
        <label class="flex flex-col gap-1.5 text-xs font-medium">
          小時
          <Select
            value={selectedHour}
            onchange={(event: Event) =>
              update(
                (event.currentTarget as HTMLSelectElement).value,
                selectedMinute,
              )}
          >
            {#each hours as hour (hour)}
              <option value={hour}>{hour}</option>
            {/each}
          </Select>
        </label>
        <span class="pb-2 text-sm font-semibold text-muted-foreground">:</span>
        <label class="flex flex-col gap-1.5 text-xs font-medium">
          分鐘
          <Select
            value={selectedMinute}
            onchange={(event: Event) =>
              update(
                selectedHour,
                (event.currentTarget as HTMLSelectElement).value,
              )}
          >
            {#each minutes as minute (minute)}
              <option value={minute}>{minute}</option>
            {/each}
          </Select>
        </label>
      </div>
      <Button size="sm" onclick={() => (open = false)}>
        <Check />完成
      </Button>
    </div>
  </Popover.Content>
</Popover.Root>
