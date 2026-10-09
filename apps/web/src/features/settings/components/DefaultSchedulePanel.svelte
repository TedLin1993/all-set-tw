<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { Check, Clock3, LoaderCircle } from "@lucide/svelte";
  import Card from "@/shared/ui/Card.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import TimePicker from "@/shared/ui/TimePicker.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import { syncScheduleQuery } from "@/data/connectors/queries";
  import type {
    SyncJobRow,
    SyncScheduleSettings,
  } from "@/data/connectors/types";

  let {
    api,
    demoMode,
    jobs,
    variant = "default",
  }: {
    api: ApiClient;
    demoMode: boolean;
    jobs: SyncJobRow[];
    variant?: "default" | "desktop";
  } = $props();

  const queryClient = useQueryClient();
  const schedule = createQuery(syncScheduleQuery(() => api));
  const intervalOptions = [
    { label: "每小時", minutes: 60 },
    { label: "每 6 小時", minutes: 360 },
    { label: "每 12 小時", minutes: 720 },
    { label: "每天", minutes: 1440 },
    { label: "每週", minutes: 10080 },
  ];
  const weekdayOptions = [
    "週日",
    "週一",
    "週二",
    "週三",
    "週四",
    "週五",
    "週六",
  ];
  let intervalMinutes = $state(1440);
  let preferredTime = $state("06:00");
  let preferredWeekday = $state(1);
  let timePickerOpen = $state(false);
  let timeBeforePickerOpened = "06:00";
  let savedSchedule = $state<SyncScheduleSettings>();
  type ScheduleInput = Pick<
    SyncScheduleSettings,
    "intervalMinutes" | "preferredTime" | "preferredWeekday"
  >;
  const draft = $derived({
    intervalMinutes,
    preferredTime,
    preferredWeekday,
  });
  const isDirty = $derived(
    savedSchedule !== undefined && !sameSchedule(draft, savedSchedule),
  );
  const inheritedJobs = $derived(
    jobs.filter((job) => job.scheduleMode === "inherit").length,
  );

  onMount(() =>
    schedule.subscribe((result) => {
      if (!result.data || isDirty || $save.isPending) return;
      savedSchedule = result.data;
      intervalMinutes = result.data.intervalMinutes;
      preferredTime = result.data.preferredTime;
      preferredWeekday = result.data.preferredWeekday;
    }),
  );

  const save = createMutation({
    scope: { id: "sync-schedule" },
    mutationFn: (input: ScheduleInput) =>
      api.put<SyncScheduleSettings>("/api/sync-schedule", input),
    onMutate: () =>
      queryClient.cancelQueries({ queryKey: queryKeys.syncSchedule }),
    onSuccess: (data) => {
      savedSchedule = data;
      queryClient.setQueryData(queryKeys.syncSchedule, data);
      queryClient.invalidateQueries({ queryKey: queryKeys.syncJobs });
    },
  });
  const saveFailed = $derived(
    $save.isError && sameSchedule(draft, $save.variables),
  );
  const saveQueued = $derived(
    !demoMode && isDirty && !timePickerOpen && !$save.isPending && !saveFailed,
  );

  function sameSchedule(left: ScheduleInput, right: ScheduleInput | undefined) {
    return (
      right !== undefined &&
      left.intervalMinutes === right.intervalMinutes &&
      left.preferredTime === right.preferredTime &&
      left.preferredWeekday === right.preferredWeekday
    );
  }

  function setTimePickerOpen(open: boolean) {
    if (open) timeBeforePickerOpened = preferredTime;
    timePickerOpen = open;
  }

  $effect(() => {
    if (!saveQueued) return;
    const input = draft;
    const timer = setTimeout(() => $save.mutate(input), 500);
    return () => clearTimeout(timer);
  });

  onDestroy(() => {
    const input = timePickerOpen
      ? { ...draft, preferredTime: timeBeforePickerOpened }
      : draft;
    if (
      demoMode ||
      !savedSchedule ||
      sameSchedule(input, savedSchedule) ||
      (($save.isError || $save.isPending) &&
        sameSchedule(input, $save.variables))
    )
      return;
    $save.mutate(input);
  });
</script>

<Card
  as="section"
  class={`overflow-hidden ${variant === "desktop" ? "border-border shadow-xs" : ""}`}
>
  <div
    class={`flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4 ${variant === "desktop" ? "border-border bg-card text-foreground" : "border-border bg-ink text-white"}`}
  >
    <div class="flex items-start gap-3">
      <span
        class={`flex size-10 shrink-0 items-center justify-center rounded-xl ${variant === "desktop" ? "bg-steel/10 text-steel" : "bg-white/10 text-white"}`}
      >
        <Clock3 class="size-5" />
      </span>
      <div>
        <h2 class="font-semibold">預設同步排程</h2>
        <p
          class={`mt-1 text-sm ${variant === "desktop" ? "text-muted-foreground" : "text-white/55"}`}
        >
          選擇跟隨預設的連接器，會從設定時間起依序同步。
        </p>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span
        class={`rounded-full px-3 py-1.5 ${variant === "desktop" ? "bg-muted text-muted-foreground" : "bg-white/10 text-white/70"}`}
      >
        Asia/Taipei
      </span>
      <span
        class={`rounded-full px-3 py-1.5 font-semibold ${variant === "desktop" ? "bg-moss/10 text-moss" : "bg-white/10"}`}
      >
        {inheritedJobs} 個連接器跟隨
      </span>
    </div>
  </div>
  <div class="flex flex-col gap-4 p-5 md:flex-row md:flex-wrap md:items-end">
    <label class="grid gap-1.5 text-sm font-medium md:w-44">
      同步頻率
      <Select
        bind:value={intervalMinutes}
        disabled={demoMode || !$schedule.data}
      >
        {#each intervalOptions as option (option.minutes)}
          <option value={option.minutes}>{option.label}</option>
        {/each}
      </Select>
    </label>
    {#if intervalMinutes === 10080}
      <label class="grid gap-1.5 text-sm font-medium md:w-36">
        執行日
        <Select
          bind:value={preferredWeekday}
          disabled={demoMode || !$schedule.data}
        >
          {#each weekdayOptions as weekday, index (weekday)}
            <option value={index}>{weekday}</option>
          {/each}
        </Select>
      </label>
    {/if}
    {#if intervalMinutes >= 1440}
      <label class="grid gap-1.5 text-sm font-medium md:w-44">
        開始時間
        <TimePicker
          bind:value={preferredTime}
          bind:open={() => timePickerOpen, setTimePickerOpen}
          disabled={demoMode || !$schedule.data}
        />
      </label>
    {:else}
      <div class="grid gap-1.5 text-sm font-medium md:w-52">
        計時方式
        <div
          class="flex h-10 items-center rounded-md border border-border bg-muted/50 px-3 text-sm text-muted-foreground"
        >
          從上次同步完成後計算
        </div>
      </div>
    {/if}
    <div
      class="text-sm leading-relaxed text-muted-foreground md:min-w-52 md:flex-1"
    >
      <p>變更會自動儲存，僅影響「跟隨預設」的來源。</p>
      <p
        role="status"
        aria-live="polite"
        class="mt-1 flex min-h-5 items-center gap-1.5 text-sm font-medium"
      >
        {#if saveQueued || $save.isPending}
          <LoaderCircle class="size-4 animate-spin" />儲存中…
        {:else if $save.isSuccess && !isDirty}
          <Check class="size-4 text-moss" /><span class="text-moss">已儲存</span
          >
        {:else if timePickerOpen && isDirty}
          完成時間選擇後會自動儲存。
        {/if}
      </p>
    </div>
  </div>
  {#if saveFailed}
    <div
      role="alert"
      class="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-coral/5 px-5 py-3 text-sm font-medium text-coral"
    >
      <p>預設排程儲存失敗，請重試。</p>
      <Button
        variant="outline"
        size="sm"
        disabled={demoMode}
        onclick={() => $save.mutate(draft)}
      >
        重試
      </Button>
    </div>
  {/if}
</Card>
