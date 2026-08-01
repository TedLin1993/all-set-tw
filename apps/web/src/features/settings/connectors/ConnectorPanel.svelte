<script lang="ts">
  import { onMount } from "svelte";
  import { toStore } from "svelte/store";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import {
    KeyRound,
    Mail,
    RefreshCw,
    Save,
    ShieldCheck,
    Smartphone,
  } from "@lucide/svelte";
  import BrowserBankConnectionHelp from "./BrowserBankConnectionHelp.svelte";
  import TdccConnectionProgress from "./TdccConnectionProgress.svelte";
  import Card from "@/shared/ui/Card.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Checkbox from "@/shared/ui/Checkbox.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import TimePicker from "@/shared/ui/TimePicker.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { ApiRequestError } from "@/shared/api/client";
  import { queryKeys } from "@/shared/api/query-keys";
  import {
    connectorSettingsQuery,
    syncJobsQuery,
    syncScheduleQuery,
  } from "@/data/connectors/queries";
  import type {
    ConnectorField,
    ConnectorId,
    SyncTarget,
  } from "@/data/connectors/types";
  import { formatDateTime } from "@/shared/format/financial";
  import { browserCaptchaFailure } from "./browser-captcha";

  let {
    api,
    connectorId,
    demoMode,
    title,
    fields,
    embedded = false,
  }: {
    api: ApiClient;
    connectorId: ConnectorId;
    demoMode: boolean;
    title: string;
    fields: ConnectorField[];
    embedded?: boolean;
  } = $props();
  const qc = useQueryClient();
  const settings = createQuery(
    toStore(() => connectorSettingsQuery(() => api, connectorId)),
  );
  const jobs = createQuery(syncJobsQuery(() => api));
  const defaultSchedule = createQuery(syncScheduleQuery(() => api));
  let values = $state<Record<string, string | boolean>>({});
  let error = $state("");
  let otp = $state("");
  let tdccSetupStep = $state<"credentials" | "email" | "sms" | "complete">(
    "credentials",
  );
  let bankCaptchaImage = $state("");
  let bankCaptcha = $state("");
  let bankCaptchaDigitCount = $state(6);
  let pendingSyncTarget = $state<SyncTarget>("default");
  const job = $derived(
    ($jobs.data ?? []).find(
      (j) => j.connectorId === connectorId && j.scope === "all",
    ),
  );
  const browserBank = $derived(
    connectorId === "sinopac" || connectorId === "taishin",
  );
  const browserBankSessionAvailable = $derived(
    browserBank && Boolean($settings.data?.sessionAvailable),
  );
  const tdccConnectionReady = $derived(
    connectorId === "tdcc" && Boolean($settings.data?.sessionAvailable),
  );
  const tdccCredentialsComplete = $derived(
    connectorId === "tdcc" && Boolean($settings.data?.credentialsComplete),
  );
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

  onMount(() =>
    settings.subscribe((result) => {
      for (const [key, value] of Object.entries(
        result.data?.publicConfig ?? {},
      )) {
        if (values[key] === undefined)
          values[key] = typeof value === "boolean" ? value : String(value);
      }
      if (connectorId === "einvoice" && values.fetchDetails === undefined)
        values.fetchDetails = true;
    }),
  );

  const save = createMutation({
    mutationFn: (config: Record<string, unknown>) => {
      if (!Object.keys(config).length) throw new Error("請先填寫欄位再儲存。");
      return api.put(`/api/connectors/${connectorId}/settings`, { config });
    },
    onSuccess: () => {
      error = "";
      for (const field of fields) {
        if (field.type === "text" || field.type === "password")
          values[field.key] = "";
      }
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    },
    onError: (e) => (error = e instanceof Error ? e.message : "儲存失敗"),
  });
  const updateJob = createMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.patch(`/api/sync-jobs/${connectorId}/all`, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.syncJobs }),
  });
  const sync = createMutation({
    mutationFn: (target: SyncTarget) => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      const path =
        connectorId === "tdcc" && target !== "default"
          ? `/api/connectors/${connectorId}/sync/${target}`
          : `/api/connectors/${connectorId}/sync`;
      pendingSyncTarget = target;
      return api.post(
        path,
        connectorId === "einvoice" ? { fetchDetails: true } : undefined,
      );
    },
    onSuccess: () => {
      error = "";
      if (connectorId === "tdcc") tdccSetupStep = "complete";
      qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
      qc.invalidateQueries({ queryKey: queryKeys.summary });
      if (connectorId === "einvoice")
        qc.invalidateQueries({ queryKey: queryKeys.invoices });
      else if (
        connectorId === "esun" ||
        connectorId === "cathaybk" ||
        connectorId === "ctbc"
      ) {
        qc.invalidateQueries({ queryKey: queryKeys.bank });
        if (connectorId !== "esun")
          qc.invalidateQueries({ queryKey: queryKeys.bills });
      } else if (browserBank) {
        qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
        qc.invalidateQueries({ queryKey: queryKeys.bank });
        qc.invalidateQueries({ queryKey: queryKeys.bills });
      } else {
        if (
          pendingSyncTarget === "default" ||
          pendingSyncTarget === "investments"
        )
          qc.invalidateQueries({ queryKey: queryKeys.investments });
        if (pendingSyncTarget === "default" || pendingSyncTarget === "trades")
          qc.invalidateQueries({ queryKey: queryKeys.investmentTransactions });
        if (pendingSyncTarget === "default" || pendingSyncTarget === "bank")
          qc.invalidateQueries({ queryKey: queryKeys.bank });
      }
    },
    onError: (e) => {
      if (handleTdccVerificationRequired(e)) return;
      error = e instanceof Error ? e.message : "同步失敗";
      if (browserBank)
        qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.syncJobs }),
  });
  const connectTdcc = createMutation({
    mutationFn: async () => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      const config = buildConfig();
      if (
        !tdccCredentialsComplete &&
        (!String(config.userId ?? "").trim() ||
          !String(config.password ?? "").trim())
      ) {
        throw new Error("請輸入身分證字號與集保 App 密碼。");
      }
      if (Object.keys(config).length > 0) {
        await api.put("/api/connectors/tdcc/settings", { config });
      }
      return api.post("/api/connectors/tdcc/sync");
    },
    onSuccess: () => finishTdccConnection(),
    onError: (e) => {
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      if (handleTdccVerificationRequired(e)) return;
      error = e instanceof Error ? e.message : "集保連線失敗";
    },
  });
  const prepareBrowserBank = createMutation({
    mutationFn: () => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      if (!browserBank) throw new Error("此資料來源不支援圖形驗證。");
      return api.post<{
        captchaImage: string;
        expiresAt: string;
        digitCount?: number;
      }>(`/api/connectors/${connectorId}/captcha`);
    },
    onSuccess: (data) => {
      error = "";
      bankCaptcha = "";
      bankCaptchaImage = data.captchaImage;
      bankCaptchaDigitCount = data.digitCount ?? 6;
    },
    onError: (e) => (error = e instanceof Error ? e.message : "取得驗證碼失敗"),
  });
  const verifyBrowserBank = createMutation({
    mutationFn: () => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      if (
        !new RegExp(`^\\d{${bankCaptchaDigitCount}}$`).test(bankCaptcha.trim())
      )
        throw new Error(
          `請輸入圖片中的 ${bankCaptchaDigitCount} 位數字驗證碼。`,
        );
      return api.post(`/api/connectors/${connectorId}/sync`, {
        captcha: bankCaptcha.trim(),
      });
    },
    onSuccess: () => {
      error = "";
      bankCaptcha = "";
      bankCaptchaImage = "";
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
      qc.invalidateQueries({ queryKey: queryKeys.summary });
      qc.invalidateQueries({ queryKey: queryKeys.bank });
      qc.invalidateQueries({ queryKey: queryKeys.bills });
      if (connectorId === "sinopac" && job && !job.enabled)
        $updateJob.mutate({ enabled: true });
    },
    onError: (e) => {
      const failure = browserCaptchaFailure(e);
      error = failure.message;
      if (failure.sessionInvalidated) {
        bankCaptcha = "";
        bankCaptchaImage = "";
        qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
      }
    },
  });
  const verifyOtp = createMutation({
    mutationFn: () => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      if (!otp.trim()) throw new Error("請先輸入驗證碼。");
      const path =
        connectorId === "tdcc" && pendingSyncTarget !== "default"
          ? `/api/connectors/${connectorId}/sync/${pendingSyncTarget}`
          : `/api/connectors/${connectorId}/sync`;
      return api.post(path, {
        otp: otp.trim(),
        otpChannel: tdccSetupStep === "sms" ? "sms" : "email",
      });
    },
    onSuccess: () => finishTdccConnection(),
    onError: (e) => {
      if (handleTdccVerificationRequired(e)) {
        otp = "";
        return;
      }
      error = e instanceof Error ? e.message : "驗證失敗";
    },
  });

  function handleTdccVerificationRequired(errorValue: unknown) {
    if (!(errorValue instanceof ApiRequestError)) return false;
    if (errorValue.code === "TDCC_EMAIL_OTP_REQUIRED") {
      error = "";
      otp = "";
      tdccSetupStep = "email";
      pendingSyncTarget = "default";
      return true;
    }
    if (errorValue.code === "TDCC_SMS_OTP_REQUIRED") {
      error = "";
      otp = "";
      tdccSetupStep = "sms";
      return true;
    }
    return false;
  }

  function finishTdccConnection() {
    error = "";
    otp = "";
    tdccSetupStep = "complete";
    $sync.reset();
    for (const field of fields) {
      if (field.type === "text" || field.type === "password")
        values[field.key] = "";
    }
    qc.invalidateQueries({
      queryKey: queryKeys.connectorSettings(connectorId),
    });
    qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    qc.invalidateQueries({ queryKey: queryKeys.summary });
    qc.invalidateQueries({ queryKey: queryKeys.investments });
    qc.invalidateQueries({ queryKey: queryKeys.investmentTransactions });
    qc.invalidateQueries({ queryKey: queryKeys.bank });
  }

  function buildConfig() {
    const entries: Array<[string, string | number | boolean]> = [];
    for (const field of fields) {
      const raw = values[field.key];
      if (raw === undefined || raw === "") continue;
      if (field.type !== "number") {
        entries.push([field.key, raw]);
        continue;
      }
      const number = Number(raw);
      if (Number.isFinite(number)) entries.push([field.key, number]);
    }
    return Object.fromEntries(entries);
  }
  function intervalLabel(minutes: number) {
    return (
      intervalOptions.find((option) => option.minutes === minutes)?.label ??
      `${minutes} 分鐘`
    );
  }
</script>

<Card
  as="article"
  class={embedded
    ? "rounded-none border-0 bg-transparent p-0 shadow-none"
    : "p-4"}
>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 class="text-lg font-semibold">
        {embedded ? "連線與同步" : title}
      </h2>
      <p class="text-sm text-ink/65">
        {connectorId === "tdcc" && tdccConnectionReady
          ? "連線已完成；登入狀態會安全保存並供後續同步使用。"
          : connectorId === "tdcc" &&
              $settings.data?.configured &&
              !tdccCredentialsComplete
            ? "舊設定缺少完整的登入資料，請重新輸入身分證字號與 App 密碼。"
            : $settings.data?.configured
              ? `已設定於 ${formatDateTime($settings.data.updatedAt)}。機密資料不會在此顯示；重新填寫欄位即可覆寫。`
              : "尚未設定"}
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      {#if connectorId === "tdcc" && tdccConnectionReady}
        <Button
          size="sm"
          disabled={demoMode || $sync.isPending || $verifyOtp.isPending}
          onclick={() => $sync.mutate("default")}
          ><RefreshCw
            class={$sync.isPending ? "size-4 animate-spin" : "size-4"}
          />{$sync.isPending ? "同步中…" : "同步"}</Button
        >
      {:else if connectorId === "tdcc"}
        <span
          class="inline-flex items-center gap-1.5 rounded-full border border-steel/20 bg-steel/[0.06] px-3 py-1.5 text-sm font-semibold text-steel"
        >
          <ShieldCheck class="size-3.5" />等待完成身分驗證
        </span>
      {:else if browserBank}
        {#if browserBankSessionAvailable}
          <Button
            size="sm"
            disabled={demoMode ||
              $sync.isPending ||
              $verifyBrowserBank.isPending}
            onclick={() => {
              error = "";
              $sync.mutate("default");
            }}
            ><RefreshCw class="size-4" />{$sync.isPending
              ? "同步中…"
              : "同步"}</Button
          >
          <Button
            size="sm"
            variant="outline"
            disabled={demoMode ||
              $prepareBrowserBank.isPending ||
              $verifyBrowserBank.isPending}
            onclick={() => {
              error = "";
              $prepareBrowserBank.mutate();
            }}
            ><KeyRound class="size-4" />{$prepareBrowserBank.isPending
              ? "取得中…"
              : "人工重新驗證"}</Button
          >
        {:else}
          <Button
            size="sm"
            disabled={demoMode ||
              $sync.isPending ||
              $prepareBrowserBank.isPending ||
              $verifyBrowserBank.isPending}
            onclick={() => {
              error = "";
              $sync.mutate("default");
            }}
            ><RefreshCw
              class={$sync.isPending ? "size-4 animate-spin" : "size-4"}
            />{$sync.isPending ? "自動驗證中…" : "自動驗證並同步"}</Button
          >
          <Button
            size="sm"
            variant="outline"
            disabled={demoMode ||
              $sync.isPending ||
              $prepareBrowserBank.isPending ||
              $verifyBrowserBank.isPending}
            onclick={() => {
              error = "";
              $prepareBrowserBank.mutate();
            }}
            ><KeyRound class="size-4" />{$prepareBrowserBank.isPending
              ? "取得中…"
              : "人工輸入驗證碼"}</Button
          >
        {/if}
      {:else}
        <Button
          size="sm"
          disabled={demoMode || $sync.isPending}
          onclick={() => {
            error = "";
            $sync.mutate("default");
          }}
          ><RefreshCw
            class={$sync.isPending ? "size-4 animate-spin" : "size-4"}
          />{$sync.isPending ? "同步中…" : "同步"}</Button
        >
      {/if}
    </div>
  </div>
  {#if demoMode}<p
      class="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      Demo site 已停用同步；你仍可查看示範資料與介面互動。
    </p>{/if}
  {#if connectorId === "tdcc"}
    <TdccConnectionProgress
      step={tdccSetupStep}
      connectionReady={tdccConnectionReady}
    />
  {:else if browserBank}
    <BrowserBankConnectionHelp
      bankName={connectorId === "taishin" ? "台新" : "永豐"}
      bind:captcha={bankCaptcha}
      captchaImage={bankCaptchaImage}
      digitCount={bankCaptchaDigitCount}
      preparing={$prepareBrowserBank.isPending}
      verifying={$verifyBrowserBank.isPending}
      onVerify={() => {
        error = "";
        $verifyBrowserBank.mutate();
      }}
      onRefresh={() => $prepareBrowserBank.mutate()}
    />
  {/if}
  <div
    class={`mt-3 rounded-xl border border-ink/10 bg-paper p-3 text-sm ${connectorId === "tdcc" && !tdccConnectionReady ? "hidden" : ""}`}
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink/70">
          <span class="font-semibold text-ink">
            自動同步：{job?.enabled ? "開" : "關"}
          </span>
          {#if browserBank}<span
              >登入：{browserBankSessionAvailable
                ? "session 可自動續用"
                : "下次同步會自動驗證"}</span
            >{/if}
          {#if job}<span
              >狀態：{job.running
                ? "同步中"
                : job.lastStatus === "success"
                  ? "正常"
                  : job.lastStatus === "failed"
                    ? "失敗"
                    : job.lastStatus === "needs_user_action"
                      ? "需要處理"
                      : "尚未同步"}</span
            >{/if}
        </div>
        {#if job?.lastRunAt}
          <p class="mt-1 text-sm text-muted-foreground">
            上次同步：{formatDateTime(job.lastRunAt)}
          </p>
        {/if}
      </div>
      {#if job}<Button
          size="sm"
          variant="outline"
          disabled={demoMode || $updateJob.isPending}
          onclick={() => $updateJob.mutate({ enabled: !job.enabled })}
          >{job.enabled ? "關閉" : "開啟"}</Button
        >{/if}
    </div>

    {#if job?.enabled}
      <div class="mt-3 grid gap-3 border-t border-ink/10 pt-3 md:grid-cols-4">
        <label class="grid gap-1 text-sm font-semibold text-ink/70">
          排程方式
          <Select
            value={job.scheduleMode ?? "custom"}
            disabled={demoMode || $updateJob.isPending}
            onchange={(event: Event) =>
              $updateJob.mutate({
                scheduleMode: (event.currentTarget as HTMLSelectElement).value,
              })}
          >
            <option value="inherit">跟隨預設</option>
            <option value="custom">自訂排程</option>
          </Select>
        </label>

        {#if job.scheduleMode === "inherit"}
          <div
            class="flex items-center rounded-lg border border-moss/15 bg-moss/5 px-3 py-2 text-sm text-moss md:col-span-3"
          >
            <span class="font-semibold">跟隨預設：</span>
            {#if $defaultSchedule.data}
              {#if $defaultSchedule.data.intervalMinutes === 10080}
                每{weekdayOptions[$defaultSchedule.data.preferredWeekday] ??
                  "週一"}
                {$defaultSchedule.data.preferredTime} 起
              {:else}
                {intervalLabel(
                  $defaultSchedule.data.intervalMinutes,
                )}{#if $defaultSchedule.data.intervalMinutes >= 1440}
                  {$defaultSchedule.data.preferredTime} 起{/if}
              {/if}
            {:else}
              讀取中…
            {/if}
          </div>
        {:else}
          <label class="grid gap-1 text-sm font-semibold text-ink/70">
            同步頻率
            <Select
              value={job.intervalMinutes}
              disabled={demoMode || $updateJob.isPending}
              onchange={(event: Event) =>
                $updateJob.mutate({
                  intervalMinutes: Number(
                    (event.currentTarget as HTMLSelectElement).value,
                  ),
                })}
            >
              {#each intervalOptions as option (option.minutes)}
                <option value={option.minutes}>{option.label}</option>
              {/each}
            </Select>
          </label>
          {#if job.intervalMinutes === 10080}
            <label class="grid gap-1 text-sm font-semibold text-ink/70">
              執行日
              <Select
                value={job.preferredWeekday}
                disabled={demoMode || $updateJob.isPending}
                onchange={(event: Event) =>
                  $updateJob.mutate({
                    preferredWeekday: Number(
                      (event.currentTarget as HTMLSelectElement).value,
                    ),
                  })}
              >
                {#each weekdayOptions as weekday, index (weekday)}
                  <option value={index}>{weekday}</option>
                {/each}
              </Select>
            </label>
          {/if}
          {#if job.intervalMinutes >= 1440}
            <label class="grid gap-1 text-sm font-semibold text-ink/70">
              開始時間
              <TimePicker
                value={job.preferredTime}
                onchange={(preferredTime) =>
                  !demoMode && $updateJob.mutate({ preferredTime })}
              />
            </label>
          {:else}
            <div
              class="flex items-end pb-2 text-sm leading-relaxed text-muted-foreground"
            >
              從上次同步完成後重新計時。
            </div>
          {/if}
        {/if}
      </div>
    {/if}
    {#if error || (job?.lastError && !bankCaptchaImage)}<p
        class="mt-2 text-sm text-coral"
      >
        {error ? `本次同步：${error}` : `上次同步：${job?.lastError}`}
      </p>{/if}
  </div>
  <section class="mt-4 overflow-hidden rounded-xl border border-border">
    <div
      class="flex flex-wrap items-start justify-between gap-2 border-b border-border bg-muted/45 px-4 py-3"
    >
      <div>
        <h3 class="text-sm font-semibold">
          {connectorId === "tdcc" ? "集保 App 身分驗證" : "連線憑證"}
        </h3>
        <p class="mt-0.5 text-sm text-muted-foreground">
          {connectorId === "tdcc"
            ? "請使用集保 e 存摺 App 的登入資料；不是券商網路下單密碼。"
            : "已儲存的機密欄位不會顯示內容；留白會維持原值。"}
        </p>
      </div>
      {#if $save.isSuccess}<span
          class="rounded-full bg-moss/10 px-2.5 py-1 text-sm font-semibold text-moss"
          >已安全儲存</span
        >{/if}
    </div>
    <div class="grid gap-3 p-4">
      {#each fields as field (field.key)}
        {#if field.type === "checkbox"}
          <label class="flex items-center gap-2 text-sm"
            ><Checkbox
              checked={Boolean(values[field.key])}
              onchange={(e: Event) =>
                (values[field.key] = (
                  e.currentTarget as HTMLInputElement
                ).checked)}
            />{field.label}</label
          >
        {:else}
          {@const storedCredential = Boolean(
            $settings.data?.configured &&
            (connectorId !== "tdcc" || tdccCredentialsComplete) &&
            (field.type === "text" || field.type === "password"),
          )}
          {@const hasReplacement = Boolean(String(values[field.key] ?? ""))}
          <label class="grid gap-1.5 text-sm font-medium">
            <span class="flex flex-wrap items-center gap-2">
              <span>{field.label}</span>
              {#if storedCredential}
                <span
                  class={`rounded-full px-2 py-0.5 text-sm font-semibold ${hasReplacement ? "bg-steel/10 text-steel" : "bg-moss/10 text-moss"}`}
                >
                  {hasReplacement ? "將更新" : "已儲存"}
                </span>
              {/if}
            </span>
            <Input
              class={storedCredential && !hasReplacement
                ? "bg-moss/[0.035] placeholder:text-ink/55"
                : ""}
              type={field.type}
              placeholder={storedCredential && !hasReplacement
                ? "••••••••　已安全儲存"
                : field.placeholder}
              value={String(values[field.key] ?? "")}
              oninput={(e: Event) =>
                (values[field.key] = (
                  e.currentTarget as HTMLInputElement
                ).value)}
            />
          </label>
        {/if}
      {/each}
    </div>
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-paper/70 px-4 py-3"
    >
      <p class="text-sm text-muted-foreground">
        {connectorId === "tdcc"
          ? tdccConnectionReady
            ? "重新填寫任一欄位會清除舊的登入狀態並重新驗證。"
            : "按下後會先登入集保；只有集保要求裝置驗證時才會寄信。"
          : "儲存完成後，再使用上方的同步按鈕測試連線。"}
      </p>
      {#if connectorId === "tdcc"}
        <Button
          size="sm"
          disabled={$connectTdcc.isPending || $verifyOtp.isPending || demoMode}
          onclick={() => {
            error = "";
            tdccSetupStep = "credentials";
            $connectTdcc.mutate();
          }}
          ><ShieldCheck class="size-4" />{$connectTdcc.isPending
            ? "正在連線…"
            : tdccConnectionReady
              ? "更新並重新連線"
              : "連線並取得驗證碼"}</Button
        >
      {:else}
        <Button
          size="sm"
          disabled={$save.isPending}
          onclick={() => {
            error = "";
            $save.reset();
            $save.mutate(buildConfig());
          }}
          ><Save class="size-4" />{$save.isPending
            ? "儲存中…"
            : "儲存憑證"}</Button
        >
      {/if}
    </div>
  </section>
  {#if $save.isError}<p class="mt-2 text-sm font-medium text-coral">
      儲存失敗：{error}
    </p>{/if}
  {#if connectorId === "tdcc" && (tdccSetupStep === "email" || tdccSetupStep === "sms")}<div
      class="mt-3 overflow-hidden rounded-xl border border-steel/20 bg-steel/[0.055]"
    >
      <div class="flex items-start gap-3 border-b border-steel/15 px-4 py-3">
        <span
          class="grid size-9 shrink-0 place-items-center rounded-full bg-steel/10 text-steel"
        >
          {#if tdccSetupStep === "sms"}<Smartphone
              class="size-4.5"
            />{:else}<Mail class="size-4.5" />{/if}
        </span>
        <div>
          <p class="text-sm font-semibold text-ink">
            {tdccSetupStep === "sms"
              ? "簡訊驗證碼已寄出"
              : "Email 驗證碼已寄出"}
          </p>
          <p class="mt-0.5 text-sm leading-relaxed text-ink/60">
            {tdccSetupStep === "sms"
              ? "Email 驗證已通過；請輸入集保寄到手機的驗證碼。"
              : "請查看集保帳號登記的電子信箱，也別忘了檢查垃圾郵件匣。"}
          </p>
        </div>
      </div>
      <div class="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label class="grid gap-1.5 text-sm font-medium">
          一次性驗證碼
          <Input
            class="bg-white/80 tracking-[0.2em]"
            inputmode="numeric"
            autocomplete="one-time-code"
            placeholder="輸入驗證碼"
            bind:value={otp}
          />
        </label>
        <Button
          class="self-end"
          size="sm"
          disabled={$verifyOtp.isPending || !otp.trim()}
          onclick={() => {
            error = "";
            $verifyOtp.mutate();
          }}
          ><ShieldCheck class="size-4" />{$verifyOtp.isPending
            ? "驗證與同步中…"
            : "驗證並完成首次同步"}</Button
        >
      </div>
      <div
        class="flex flex-wrap items-center justify-between gap-2 border-t border-steel/15 px-4 py-2.5"
      >
        <button
          type="button"
          class="text-sm font-semibold text-ink/55 underline-offset-4 hover:text-ink hover:underline"
          onclick={() => {
            otp = "";
            tdccSetupStep = "credentials";
          }}>返回修改帳密</button
        >
        {#if tdccSetupStep === "email"}<Button
            size="sm"
            variant="outline"
            disabled={$sync.isPending}
            onclick={() => {
              error = "";
              $sync.mutate("default");
            }}
            ><RefreshCw class="size-4" />{$sync.isPending
              ? "重新寄送中…"
              : "重新寄送 Email"}</Button
          >{/if}
      </div>
    </div>{/if}
  {#if connectorId === "tdcc" && error}<p
      class="mt-3 rounded-lg border border-coral/20 bg-coral/[0.06] px-3 py-2 text-sm font-medium text-coral"
    >
      {error}
    </p>{/if}
  <p class="mt-3 text-sm text-ink/50">
    {connectorId === "sinopac"
      ? "永豐 session 失效時會由 Gemma 4 自動辨識並登入，連續三次失敗後才需人工驗證。"
      : connectorId === "tdcc"
        ? "排程同步不會在背景寄送驗證碼；登入失效時會標記為需要重新驗證。"
        : "輸入完帳號密碼後，請先按「儲存設定」，再按「同步」。"}
  </p>
</Card>
