<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    createInstallation,
    fetchAccounts,
    fetchCurrentRelease,
    fetchInstallation,
    fetchInstallationJob,
    fetchInstallations,
    fetchUpdatePlan,
    resumeInstallation,
    runPrecheck,
    selectAccount,
    startUpdate,
  } from "@/data/deployer";
  import type {
    AuthSession,
    CloudflareAccount,
    CurrentRelease,
    DeployJob,
    Installation,
    PrecheckResult,
    UpdatePlan,
  } from "@/data/types";
  import { ApiRequestError } from "@/shared/api/client";
  import { checkLabels, precheckSummary } from "./model/precheck";
  import { interruptionCopy, updateUnavailableCopy } from "./model/progress";
  import ProgressPanel from "./components/ProgressPanel.svelte";

  let { session }: { session: AuthSession } = $props();

  let accounts = $state<CloudflareAccount[]>([]);
  let accountId = $state("");
  let workerName = $state("taiwan-fin-hub");
  let allowedEmail = $state("");
  let loadError = $state("");
  let actionError = $state("");
  let precheck = $state<PrecheckResult | null>(null);
  let release = $state<CurrentRelease | null>(null);
  let installation = $state<Installation | null>(null);
  let job = $state<DeployJob | null>(null);
  let updatePlan = $state<UpdatePlan | null>(null);
  let busy = $state(false);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollInFlight = false;

  const summary = $derived(precheck ? precheckSummary(precheck.checks) : null);
  const precheckMatchesInput = $derived(
    precheck?.accountId === accountId && precheck?.workerName === workerName,
  );
  const existingInstall = $derived(Boolean(installation));
  const jobInFlight = $derived(
    Boolean(
      job &&
      (job.status === "queued" ||
        job.status === "running" ||
        job.status === "awaiting_reauth" ||
        job.status === "awaiting_release"),
    ),
  );
  const canStartUpdate = $derived(
    Boolean(
      updatePlan?.available &&
      updatePlan.targetVersion &&
      updatePlan.targetDigest &&
      job?.status !== "failed" &&
      !jobInFlight,
    ),
  );

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setTimeout(() => {
      void refreshJob();
    }, 2000);
  }

  async function refreshJob() {
    if (!installation || !job || pollInFlight) return;
    pollInFlight = true;
    try {
      const result = await fetchInstallationJob(installation.id, job.id);
      installation = result.installation;
      job = result.job;
      if (
        result.job.status === "succeeded" ||
        result.job.status === "failed" ||
        result.job.status === "awaiting_reauth" ||
        result.job.status === "awaiting_release"
      ) {
        stopPolling();
        if (result.job.status === "succeeded") {
          await loadUpdatePlan();
        }
        return;
      }
      startPolling();
    } catch (error) {
      stopPolling();
      if (error instanceof ApiRequestError && error.status === 401) {
        actionError = "授權已過期，請重新授權後續跑。";
        return;
      }
      actionError =
        error instanceof Error ? error.message : "無法更新安裝進度。";
    } finally {
      pollInFlight = false;
    }
  }

  async function loadAccounts() {
    try {
      const result = await fetchAccounts();
      accounts = result.accounts;
      if (!accountId) {
        accountId = session.selectedAccountId ?? accounts[0]?.id ?? "";
      }
    } catch (error) {
      loadError = error instanceof Error ? error.message : "無法載入帳戶。";
    }
  }

  async function loadRelease() {
    try {
      release = await fetchCurrentRelease();
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.code === "RELEASE_UNAVAILABLE"
      ) {
        release = null;
        return;
      }
      actionError = error instanceof Error ? error.message : "無法載入版本。";
    }
  }

  async function loadUpdatePlan() {
    if (!installation) {
      updatePlan = null;
      return;
    }
    if (
      installation.status !== "ready" &&
      installation.status !== "update_failed"
    ) {
      updatePlan = null;
      return;
    }
    try {
      updatePlan = await fetchUpdatePlan(installation.id);
    } catch (error) {
      actionError =
        error instanceof Error ? error.message : "無法載入更新計畫。";
    }
  }

  async function loadExisting() {
    stopPolling();
    installation = null;
    job = null;
    updatePlan = null;
    if (!accountId) return;
    try {
      const listed = await fetchInstallations();
      const current = listed.installations[0];
      if (!current) return;
      const detail = await fetchInstallation(current.id);
      installation = detail.installation;
      job = detail.job;
      workerName = detail.installation.workerName;
      allowedEmail = detail.installation.allowedEmail;
      if (
        detail.job &&
        (detail.job.status === "queued" ||
          detail.job.status === "running" ||
          detail.job.status === "awaiting_reauth" ||
          detail.job.status === "awaiting_release")
      ) {
        startPolling();
      }
      await loadUpdatePlan();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        actionError = "授權已過期，請重新授權後續跑。";
        return;
      }
      actionError =
        error instanceof Error ? error.message : "無法載入既有安裝。";
    }
  }

  async function onSelectAccount() {
    actionError = "";
    busy = true;
    try {
      await selectAccount(accountId);
      await loadExisting();
    } catch (error) {
      actionError = error instanceof Error ? error.message : "無法選擇帳戶。";
    } finally {
      busy = false;
    }
  }

  async function onPrecheck() {
    actionError = "";
    busy = true;
    try {
      await selectAccount(accountId);
      await loadExisting();
      precheck = await runPrecheck({ accountId, workerName });
    } catch (error) {
      actionError = error instanceof Error ? error.message : "預檢失敗。";
    } finally {
      busy = false;
    }
  }

  async function onCreateInstallation() {
    actionError = "";
    busy = true;
    try {
      const targetVersion = release?.version ?? "pending";
      const targetDigest = release?.digest ?? "0".repeat(64);
      const result = await createInstallation({
        accountId,
        workerName,
        allowedEmail,
        targetVersion,
        targetDigest,
      });
      installation = result.installation;
      job = result.job;
      if (
        result.job.status === "queued" ||
        result.job.status === "running" ||
        result.job.status === "awaiting_reauth" ||
        result.job.status === "awaiting_release"
      ) {
        startPolling();
      }
    } catch (error) {
      actionError =
        error instanceof ApiRequestError ? error.message : "無法建立安裝。";
    } finally {
      busy = false;
    }
  }

  async function onStartUpdate() {
    if (
      !installation ||
      !updatePlan?.targetVersion ||
      !updatePlan.targetDigest
    ) {
      return;
    }
    actionError = "";
    busy = true;
    try {
      const result = await startUpdate(installation.id, {
        targetVersion: updatePlan.targetVersion,
        targetDigest: updatePlan.targetDigest,
      });
      installation = result.installation;
      job = result.job;
      startPolling();
    } catch (error) {
      actionError =
        error instanceof ApiRequestError ? error.message : "無法開始更新。";
    } finally {
      busy = false;
    }
  }

  async function onRetry() {
    if (!installation) return;
    actionError = "";
    busy = true;
    try {
      const result = await resumeInstallation(installation.id);
      installation = result.installation;
      job = result.job;
      startPolling();
    } catch (error) {
      actionError = error instanceof Error ? error.message : "無法續跑安裝。";
    } finally {
      busy = false;
    }
  }

  void (async () => {
    await loadAccounts();
    await loadRelease();
    if (accountId) {
      try {
        await selectAccount(accountId);
      } catch (error) {
        actionError = error instanceof Error ? error.message : "無法選擇帳戶。";
        return;
      }
      await loadExisting();
    }
  })();
  onDestroy(stopPolling);
</script>

<section class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
  <header class="flex flex-col gap-2">
    <p class="text-sm font-medium text-steel">授權完成</p>
    <h1 class="text-2xl font-semibold">
      {existingInstall ? "管理安裝與更新" : "選擇帳戶並開始安裝"}
    </h1>
    <p class="text-sm leading-6 text-ink/75">
      {#if existingInstall}
        已安裝的帳戶會保留 D1、Access
        與金鑰。更新前會暫停同步；失敗時保留復原點，不會倒跑 SQL。正式 OAuth 與
        R2 latest 尚未接上。
      {:else}
        只會列出此次 Cloudflare 授權實際能管理的帳戶。缺少 workers.dev 或 Zero
        Trust 時，請用下方連結到 Dashboard
        完成後再回來續做。沒有版本包時會停在可續跑狀態，不會寫入你的帳戶。
      {/if}
    </p>
  </header>

  {#if loadError}
    <p class="text-sm text-red-800">{loadError}</p>
  {/if}

  {#if release}
    <p class="text-sm leading-6 text-ink/75">
      目前發布版本：{release.version}（{release.source === "local_fixture"
        ? "本機測試包"
        : "維護者發布"}）
    </p>
  {:else}
    <p class="text-sm leading-6 text-ink/75">
      目前沒有可安裝的版本包。你仍可完成預檢，建立安裝後會等待發布。
    </p>
  {/if}

  <label class="flex flex-col gap-2 text-sm">
    Cloudflare 帳戶
    <select
      class="min-h-11 rounded-md border border-ink/15 bg-white px-3"
      bind:value={accountId}
      onchange={() => void onSelectAccount()}
    >
      {#each accounts as account}
        <option value={account.id}>{account.name}</option>
      {/each}
    </select>
  </label>

  <label class="flex flex-col gap-2 text-sm">
    Worker 名稱
    <input
      class="min-h-11 rounded-md border border-ink/15 bg-white px-3"
      bind:value={workerName}
      disabled={existingInstall}
    />
  </label>

  <label class="flex flex-col gap-2 text-sm">
    允許登入的 Email
    <input
      type="email"
      class="min-h-11 rounded-md border border-ink/15 bg-white px-3"
      bind:value={allowedEmail}
      placeholder="you@example.com"
      disabled={existingInstall}
    />
  </label>

  {#if !existingInstall}
    <div class="flex flex-wrap gap-3">
      <button
        type="button"
        class="min-h-11 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50"
        disabled={busy || !accountId}
        onclick={onPrecheck}
      >
        執行預檢
      </button>
      <button
        type="button"
        class="min-h-11 rounded-md border border-ink/20 px-4 text-sm font-medium disabled:opacity-50"
        disabled={busy ||
          !accountId ||
          !allowedEmail ||
          !summary?.ready ||
          !precheckMatchesInput}
        onclick={onCreateInstallation}
      >
        建立我的不用記帳
      </button>
    </div>
  {/if}

  {#if summary && precheckMatchesInput && !existingInstall}
    <ul class="flex flex-col gap-2">
      {#each precheck?.checks ?? [] as check}
        <li class="rounded-md border border-ink/10 bg-white px-3 py-2 text-sm">
          <span class="font-medium">{checkLabels[check.id]}</span>
          {check.ok ? "已通過" : "需要處理"}
          {#if !check.ok && check.dashboardUrl}
            <a class="ml-2 text-steel underline" href={check.dashboardUrl}
              >前往 Dashboard</a
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if updatePlan}
    <section
      class="flex flex-col gap-3 rounded-xl border border-ink/10 bg-white p-4"
    >
      <h2 class="text-lg font-semibold">版本更新</h2>
      <p class="text-sm leading-6 text-ink/75">
        目前 {updatePlan.currentVersion ?? "未知"}
        {#if updatePlan.targetVersion}
          → 目標 {updatePlan.targetVersion}
        {/if}
      </p>
      {#if updatePlan.available}
        <p class="text-sm leading-6 text-ink/75">
          {interruptionCopy(updatePlan)}
        </p>
        {#if updatePlan.pendingMigrations.length > 0}
          <ul class="list-disc space-y-1 pl-5 text-sm leading-6 text-ink/75">
            {#each updatePlan.pendingMigrations as name}
              <li>{name}</li>
            {/each}
          </ul>
        {/if}
        <button
          type="button"
          class="min-h-11 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50"
          disabled={busy || !canStartUpdate}
          onclick={onStartUpdate}
        >
          更新
        </button>
      {:else}
        <p class="text-sm leading-6 text-ink/80">
          {updateUnavailableCopy(updatePlan.reason)}
        </p>
      {/if}
    </section>
  {/if}

  {#if installation && job}
    <ProgressPanel {installation} {job} {busy} {onRetry} />
  {/if}

  {#if actionError}
    <p class="text-sm leading-6 text-ink/80">{actionError}</p>
  {/if}
</section>
