<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import type { ApiClient } from "@/shared/api/client";
  import type { MobileSettingsView, View } from "@/app/types";
  import { exchangeRatesQuery } from "@/data/assets/queries";
  import { bankQuery } from "@/data/bank/queries";
  import { classificationRulesQuery } from "@/data/classification/queries";
  import {
    connectorDefinitions,
    connectorFields,
  } from "@/data/connectors/definitions";
  import { syncJobsQuery } from "@/data/connectors/queries";
  import {
    getActionableSyncJobs,
    getConfiguredSyncJobs,
  } from "@/data/connectors/sync-status";
  import { notificationConfigQuery } from "@/data/notifications/queries";
  import type { ConnectorId } from "@/data/connectors/types";
  import { formatDateTime } from "@/shared/format/financial";
  import ClassificationRulesPanel from "./components/ClassificationRulesPanel.svelte";
  import DefaultSchedulePanel from "./components/DefaultSchedulePanel.svelte";
  import ExchangeRatesPanel from "./components/ExchangeRatesPanel.svelte";
  import MobileMore from "./components/MobileMore.svelte";
  import NotificationPanel from "./components/NotificationPanel.svelte";
  import SourceCard from "./components/SourceCard.svelte";
  import ConnectorPanel from "./connectors/ConnectorPanel.svelte";
  let {
    api,
    demoMode,
    mobileView,
    navigate,
  }: {
    api: ApiClient;
    demoMode: boolean;
    mobileView?: MobileSettingsView | "more";
    navigate: (view: View) => void;
  } = $props();
  const sources = connectorDefinitions;
  const weekdayLabels = [
    "週日",
    "週一",
    "週二",
    "週三",
    "週四",
    "週五",
    "週六",
  ];
  const settingTabs = [
    { view: "settings" as const, label: "總覽" },
    { view: "data-sources" as const, label: "資料來源" },
    { view: "sync-notifications" as const, label: "同步與通知" },
    { view: "exchange-rates" as const, label: "匯率" },
    { view: "classification-rules" as const, label: "分類規則" },
  ];
  const jobs = createQuery(syncJobsQuery(() => api));
  const rules = createQuery(classificationRulesQuery(() => api));
  const bank = createQuery(bankQuery(() => api));
  const rates = createQuery(exchangeRatesQuery(() => api));
  const notifications = createQuery(notificationConfigQuery(() => api));
  let selectedConnector = $state<ConnectorId | null>(null);
  const needsAction = $derived(getActionableSyncJobs($jobs.data ?? []).length);
  const configuredSources = $derived(getConfiguredSyncJobs($jobs.data ?? []));
  const healthySources = $derived(
    Math.max(configuredSources.length - needsAction, 0),
  );
  const actionJob = $derived(getActionableSyncJobs($jobs.data ?? []).at(0));
  const actionSource = $derived(
    sources.find((source) => source.id === actionJob?.connectorId),
  );
  const latestSuccessAt = $derived(
    ($jobs.data ?? []).reduce<string | undefined>((latest, job) => {
      if (!job.lastSuccessAt) return latest;
      return !latest || job.lastSuccessAt > latest ? job.lastSuccessAt : latest;
    }, undefined),
  );
  const inheritedJob = $derived(
    configuredSources.find(
      (job) => job.enabled && job.scheduleMode === "inherit",
    ),
  );
  const inheritedJobCount = $derived(
    configuredSources.filter(
      (job) => job.enabled && job.scheduleMode === "inherit",
    ).length,
  );
  const scheduleSummary = $derived(
    !inheritedJob
      ? "尚未設定"
      : inheritedJob.intervalMinutes === 1440
        ? `每天 ${inheritedJob.preferredTime}`
        : inheritedJob.intervalMinutes === 10080
          ? `每${weekdayLabels[inheritedJob.preferredWeekday] ?? "週一"} ${inheritedJob.preferredTime}`
          : `每 ${inheritedJob.intervalMinutes / 60} 小時`,
  );
  const ratesSummary = $derived(
    ($rates.data ?? [])
      .map((rate) => `${rate.currency} ${rate.rateTwd.toFixed(3)}`)
      .join(" · ") || "尚未設定",
  );
  const notificationSummary = $derived(
    $notifications.isPending
      ? "載入中…"
      : $notifications.data?.enabled
        ? "已開啟"
        : "未啟用",
  );
  const notificationDescription = $derived(
    $notifications.data?.enabled
      ? "失敗與重新驗證時通知"
      : "前往同步與通知開啟",
  );
  const rulesSummary = $derived(
    $rules.isPending ? "載入中…" : `${$rules.data?.length ?? 0} 條銀行交易規則`,
  );
  const enabledRuleCount = $derived(
    ($rules.data ?? []).filter((rule) => rule.enabled).length,
  );
  const recentJobs = $derived(getConfiguredSyncJobs($jobs.data ?? []));
  const recentSuccessCount = $derived(
    recentJobs.filter((job) => job.lastStatus === "success").length,
  );
  const nextRunAt = $derived(
    recentJobs.reduce<string | undefined>((next, job) => {
      if (!job.nextRunAt) return next;
      return !next || job.nextRunAt < next ? job.nextRunAt : next;
    }, undefined),
  );
  function selectConnector(id: ConnectorId) {
    selectedConnector = selectedConnector === id ? null : id;
  }

  function isActiveTab(tabView: (typeof settingTabs)[number]["view"]) {
    return tabView === "settings"
      ? !mobileView || mobileView === "more"
      : mobileView === tabView;
  }
</script>

<div class="grid min-w-0 gap-5">
  <nav
    aria-label="設定分類"
    class="no-scrollbar hidden overflow-x-auto border-b border-border bg-card md:flex md:gap-1 md:px-1"
  >
    {#each settingTabs as tab (tab.view)}
      <button
        class={`min-h-11 shrink-0 rounded-t-lg px-4 text-sm font-semibold transition ${isActiveTab(tab.view) ? "bg-muted text-steel" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
        aria-current={isActiveTab(tab.view) ? "page" : undefined}
        onclick={() => navigate(tab.view)}>{tab.label}</button
      >
    {/each}
  </nav>

  {#if mobileView === "more"}
    <MobileMore
      {demoMode}
      jobs={$jobs.data ?? []}
      rules={$rules.data ?? []}
      bank={$bank.data ?? { accounts: [], transactions: [] }}
      {navigate}
      {api}
    />
  {:else if mobileView === "data-sources"}
    <div class="grid min-w-0 gap-4">
      <section aria-label="資料來源頁標題" class="hidden min-w-0 md:block">
        <div>
          <h2 class="text-2xl font-bold tracking-tight">資料來源與連接器</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            管理連線、驗證狀態與最近同步結果。
          </p>
        </div>
      </section>

      <div
        class="hidden gap-4 md:grid lg:grid-cols-[minmax(0,620px)_minmax(0,1fr)]"
      >
        <section
          aria-label="資料來源清單"
          class="grid min-w-0 content-start gap-3"
        >
          {#each sources as source (source.id)}
            <SourceCard
              {api}
              {...source}
              id={source.id}
              jobs={$jobs.data ?? []}
              compact
              compactCard
              selected={selectedConnector === source.id}
              onConfigure={() => selectConnector(source.id)}
            />
          {/each}
        </section>

        <section
          aria-label="連接器詳情"
          class="min-h-[520px] min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs"
        >
          {#if selectedConnector}
            {@const selectedSource = sources.find(
              (source) => source.id === selectedConnector,
            )}
            <div class="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 class="text-lg font-bold">{selectedSource?.title}</h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {selectedSource?.description}
                </p>
              </div>
              <button
                class="text-sm font-semibold text-muted-foreground hover:text-foreground"
                onclick={() => (selectedConnector = null)}>關閉</button
              >
            </div>
            {#key selectedConnector}<ConnectorPanel
                {api}
                connectorId={selectedConnector}
                {demoMode}
                title={selectedSource?.title ?? "連接器"}
                fields={connectorFields[selectedConnector]}
                embedded
              />{/key}
          {:else}
            <div class="grid min-h-[480px] place-items-center text-center">
              <div>
                <p class="text-base font-semibold">選擇一個連接器</p>
                <p class="mt-1 text-sm text-muted-foreground">
                  查看連線狀態、同步範圍與驗證設定。
                </p>
              </div>
            </div>
          {/if}
        </section>
      </div>

      <section
        aria-label="資料來源與連接器"
        class="grid min-w-0 gap-3 sm:grid-cols-2 md:hidden"
      >
        {#each sources as source (source.id)}
          <SourceCard
            {api}
            {...source}
            id={source.id}
            jobs={$jobs.data ?? []}
            selected={selectedConnector === source.id}
            onConfigure={() => selectConnector(source.id)}
          >
            {#if selectedConnector === source.id}
              {#key source.id}<ConnectorPanel
                  {api}
                  connectorId={source.id}
                  {demoMode}
                  title={source.title}
                  fields={connectorFields[source.id]}
                  embedded
                />{/key}
            {/if}
          </SourceCard>
        {/each}
      </section>
    </div>
  {:else if mobileView === "sync-notifications"}
    <div class="grid min-w-0 gap-4">
      <section aria-label="同步通知頁標題" class="hidden min-w-0 md:block">
        <h2 class="text-2xl font-bold tracking-tight">同步與通知</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          設定所有連接器共用的預設排程與通知時機。
        </p>
      </section>

      <div
        class="hidden gap-4 md:grid lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]"
      >
        <DefaultSchedulePanel
          {api}
          {demoMode}
          jobs={$jobs.data ?? []}
          variant="desktop"
        />
        <NotificationPanel {api} {demoMode} variant="desktop" />
      </div>

      <section
        aria-label="最近排程"
        class="hidden min-w-0 rounded-xl border border-border bg-card p-[18px] shadow-xs md:block"
      >
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-base font-bold">最近一次排程</h2>
          <span class="text-sm text-muted-foreground">
            {latestSuccessAt ? formatDateTime(latestSuccessAt) : "尚無紀錄"}
          </span>
        </div>
        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          <div class="rounded-lg bg-muted px-3 py-2.5">
            <p class="text-sm font-bold text-moss">
              {recentSuccessCount} 個成功
            </p>
          </div>
          <div class="rounded-lg bg-coral/5 px-3 py-2.5">
            <p class="text-sm font-bold text-coral">{needsAction} 個需要處理</p>
          </div>
          <div class="rounded-lg bg-muted px-3 py-2.5">
            <p class="text-sm font-semibold">
              下次：{nextRunAt ? formatDateTime(nextRunAt) : "尚未排程"}
            </p>
          </div>
        </div>
      </section>

      <div class="grid min-w-0 gap-4 md:hidden">
        <DefaultSchedulePanel {api} {demoMode} jobs={$jobs.data ?? []} />
        <NotificationPanel {api} {demoMode} />
      </div>
    </div>
  {:else if mobileView === "exchange-rates"}
    <div class="grid min-w-0 gap-4">
      <div class="hidden items-center justify-between gap-4 md:flex">
        <div>
          <h2 class="text-2xl font-bold tracking-tight">匯率</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            管理資產與活動使用的換算基準。
          </p>
        </div>
        <span class="rounded-lg bg-steel px-4 py-2 text-sm font-bold text-white"
          >更新匯率</span
        >
      </div>

      <section
        aria-label="匯率摘要"
        class="hidden min-w-0 gap-3 md:grid md:grid-cols-3"
      >
        <div class="rounded-xl border border-border bg-card p-4 shadow-xs">
          <p class="text-sm font-semibold text-muted-foreground">基準幣別</p>
          <p class="mt-2 text-lg font-bold">TWD</p>
          <p class="mt-1 text-sm text-muted-foreground">新台幣</p>
        </div>
        <div class="rounded-xl border border-border bg-card p-4 shadow-xs">
          <p class="text-sm font-semibold text-muted-foreground">資料來源</p>
          <p class="mt-2 text-lg font-bold">手動設定</p>
          <p class="mt-1 text-sm text-muted-foreground">以設定值換算</p>
        </div>
        <div class="rounded-xl bg-muted p-4">
          <p class="text-sm font-semibold text-muted-foreground">自訂匯率</p>
          <p class="mt-2 text-lg font-bold">{$rates.data?.length ?? 0} 筆</p>
          <p class="mt-1 text-sm font-semibold text-steel">可在下方編輯</p>
        </div>
      </section>

      <div class="hidden md:block">
        <ExchangeRatesPanel {api} variant="desktop" />
      </div>
      <aside
        class="hidden rounded-lg bg-muted p-3 text-sm text-muted-foreground md:block"
      >
        匯率僅用於資產總覽與統計換算，不會變更原始交易幣別或金額。
      </aside>
      <div class="md:hidden">
        <ExchangeRatesPanel {api} />
      </div>
    </div>
  {:else if mobileView === "classification-rules"}
    <div class="grid min-w-0 gap-4">
      <div class="hidden items-center justify-between gap-4 md:flex">
        <div>
          <h2 class="text-2xl font-bold tracking-tight">分類規則</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            依照優先順序，自動為銀行交易套用分類與計算設定。
          </p>
        </div>
        <span class="rounded-lg bg-steel px-4 py-2 text-sm font-bold text-white"
          >＋ 新增規則</span
        >
      </div>

      <section
        aria-label="分類規則摘要"
        class="hidden min-w-0 gap-3 md:grid md:grid-cols-2"
      >
        <div class="rounded-xl border border-border bg-card p-3.5 shadow-xs">
          <p class="text-sm font-semibold text-muted-foreground">規則總數</p>
          <p class="mt-1 text-lg font-bold">{$rules.data?.length ?? 0}</p>
        </div>
        <div class="rounded-xl border border-border bg-card p-3.5 shadow-xs">
          <p class="text-sm font-semibold text-muted-foreground">已啟用</p>
          <p class="mt-1 text-lg font-bold text-moss">{enabledRuleCount}</p>
        </div>
      </section>

      <div
        class="hidden gap-4 md:grid lg:grid-cols-[minmax(0,690px)_minmax(0,1fr)]"
      >
        <ClassificationRulesPanel {api} />
        <aside
          class="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs"
          aria-label="規則如何運作"
        >
          <h2 class="text-base font-bold">規則如何運作</h2>
          <p class="mt-2 text-sm leading-relaxed text-muted-foreground">
            同步完成後，系統由上到下檢查規則。第一個符合條件的規則會套用到交易。
          </p>
          <div class="mt-5 rounded-lg bg-muted p-3">
            <p class="text-sm font-bold">優先順序很重要</p>
            <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
              將條件較精確的規則放在前面；可在下方調整規則順序。
            </p>
          </div>
          <p class="mt-5 text-sm leading-relaxed text-muted-foreground">
            儲存規則後，交易資料重新載入時會依目前順序重新判定；已手動分類的交易仍以手動覆寫為準。
          </p>
        </aside>
      </div>
      <div class="w-full min-w-0 md:hidden">
        <ClassificationRulesPanel {api} />
      </div>
    </div>
  {:else}
    <div class="grid min-w-0 gap-4">
      <section
        aria-label="設定總覽介紹"
        class="flex min-w-0 flex-wrap items-center justify-between gap-3"
      >
        <div>
          <h2 class="text-2xl font-bold tracking-tight">設定總覽</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            先處理資料異常，再調整日常偏好。
          </p>
        </div>
        <p class="text-sm text-muted-foreground">
          狀態更新：{latestSuccessAt
            ? formatDateTime(latestSuccessAt)
            : "尚無同步紀錄"}
        </p>
      </section>

      <section
        aria-label="資料狀態"
        class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]"
      >
        <div
          class={`min-w-0 rounded-xl border bg-card p-5 shadow-xs ${needsAction ? "border-coral/70 border-l-4" : "border-border"}`}
        >
          <div class="flex items-center justify-between gap-3">
            <p
              class={`text-sm font-semibold ${needsAction ? "text-coral" : "text-moss"}`}
            >
              {needsAction ? `需要處理 · ${needsAction}` : "資料同步狀態"}
            </p>
            <span class="text-sm font-semibold text-muted-foreground">
              {needsAction ? "影響資料更新" : "目前正常"}
            </span>
          </div>
          <h2 class="mt-2 text-xl font-bold">
            {#if needsAction}
              {actionSource?.title ?? "資料來源需要處理"}
            {:else if configuredSources.length}
              {healthySources} / {configuredSources.length} 已設定來源正常
            {:else}
              尚未設定資料來源
            {/if}
          </h2>
          <p class="mt-1 text-sm text-muted-foreground">
            {needsAction
              ? "完成重新驗證後即可恢復自動同步。"
              : configuredSources.length
                ? "所有已設定連接器都能正常同步。"
                : "設定資料來源後即可開始同步。"}
          </p>
          <button
            class="mt-4 rounded-lg bg-steel px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-steel/90"
            onclick={() => navigate("data-sources")}
            >{needsAction ? "查看連接器" : "管理資料來源"}</button
          >
        </div>

        <div
          class="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs"
          aria-label="資料健康度"
        >
          <div class="flex items-center justify-between gap-3">
            <p class="text-sm font-semibold text-muted-foreground">
              資料健康度
            </p>
            <span
              class={`text-sm font-semibold ${needsAction ? "text-coral" : "text-moss"}`}
              >{needsAction ? "需要處理" : "大致正常"}</span
            >
          </div>
          <p class="mt-2 text-3xl font-bold">
            {healthySources} / {configuredSources.length}
          </p>
          <p class="mt-1 text-sm text-muted-foreground">
            {inheritedJobCount} 個排程啟用 · {latestSuccessAt
              ? `最近成功 ${formatDateTime(latestSuccessAt)}`
              : "尚無成功紀錄"}
          </p>
        </div>
      </section>

      <section
        aria-label="資料來源與自動化"
        class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]"
      >
        <div
          class="min-w-0 rounded-xl border border-border bg-card p-[18px] shadow-xs"
        >
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-lg font-bold">資料來源與連接器</h2>
            <button
              class="text-sm font-semibold text-steel transition hover:text-steel/80"
              onclick={() => navigate("data-sources")}>管理全部 →</button
            >
          </div>
          <div class="mt-2">
            {#each sources as source (source.id)}
              <SourceCard
                {api}
                {...source}
                id={source.id}
                jobs={$jobs.data ?? []}
                compact
                selected={false}
                onConfigure={() => navigate("data-sources")}
              />
            {/each}
          </div>
        </div>

        <div class="grid min-w-0 gap-3">
          <button
            type="button"
            class="min-w-0 rounded-xl border border-border bg-card p-[17px] text-left shadow-xs transition hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-sm"
            onclick={() => navigate("sync-notifications")}
          >
            <h2 class="text-base font-bold">預設同步排程</h2>
            <p class="mt-1 text-xl font-bold">{scheduleSummary}</p>
            <p class="mt-1 text-sm text-muted-foreground">
              {inheritedJobCount} 個連接器套用
            </p>
            <span class="mt-3 block text-sm font-semibold text-steel"
              >管理 →</span
            >
          </button>
          <button
            type="button"
            class="min-w-0 rounded-xl border border-border bg-card p-[17px] text-left shadow-xs transition hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-sm"
            onclick={() => navigate("sync-notifications")}
          >
            <h2 class="text-base font-bold">通知設定</h2>
            <p class="mt-1 text-xl font-bold">{notificationSummary}</p>
            <p class="mt-1 text-sm text-muted-foreground">
              {notificationDescription}
            </p>
            <span class="mt-3 block text-sm font-semibold text-steel"
              >管理 →</span
            >
          </button>
        </div>
      </section>

      <section aria-label="其他設定" class="grid min-w-0 gap-4 md:grid-cols-2">
        <button
          type="button"
          class="min-w-0 rounded-xl border border-border bg-card p-[18px] text-left shadow-xs transition hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-sm"
          onclick={() => navigate("exchange-rates")}
        >
          <h2 class="text-base font-bold">匯率</h2>
          <p
            class="mt-2 break-words text-sm leading-relaxed text-muted-foreground"
          >
            {ratesSummary}
          </p>
          <span class="mt-4 block text-sm font-semibold text-steel"
            >開啟設定 →</span
          >
        </button>
        <button
          type="button"
          class="min-w-0 rounded-xl border border-border bg-card p-[15px] text-left shadow-xs transition hover:-translate-y-0.5 hover:border-ink/20 hover:shadow-sm"
          onclick={() => navigate("classification-rules")}
        >
          <h2 class="text-base font-bold">分類規則</h2>
          <p class="mt-1 text-sm text-muted-foreground">{rulesSummary}</p>
          <span class="mt-3 block text-sm font-semibold text-steel"
            >開啟設定 →</span
          >
        </button>
      </section>
    </div>
  {/if}
</div>
