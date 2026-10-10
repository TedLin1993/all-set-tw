<script lang="ts">
  import { onDestroy, onMount } from "svelte";
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
  import ConnectionProgress from "./ConnectionProgress.svelte";
  import Card from "@/shared/ui/Card.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import TimePicker from "@/shared/ui/TimePicker.svelte";
  import type { ApiClient } from "@/shared/api/client";
  import { ApiRequestError } from "@/shared/api/client";
  import { isRequestInterrupted } from "@/shared/api/interrupted";
  import { queryKeys } from "@/shared/api/query-keys";
  import {
    connectorSettingsQuery,
    syncJobsQuery,
    syncScheduleQuery,
  } from "@/data/connectors/queries";
  import type {
    ConnectorField,
    ConnectorId,
    QueuedSyncResponse,
    SyncTarget,
  } from "@/data/connectors/types";
  import { formatDateTime } from "@/shared/format/financial";
  import {
    browserCaptchaFailure,
    isManualCaptchaRequired,
    isMegabankOtpRequired,
    megabankOtpFailure,
    needsNextbankCaptcha,
  } from "./browser-captcha";
  import { shouldEnableScheduleAfterFirstSync } from "./schedule-after-sync";

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
  let values = $state<Record<string, string>>({});
  let focusedCredentialKeys = $state<Record<string, boolean>>({});
  let error = $state("");
  let otp = $state("");
  let tdccSetupStep = $state<"credentials" | "email" | "sms" | "complete">(
    "credentials",
  );
  let cathayVerificationStep = $state<
    "idle" | "choose" | "email" | "sms" | "complete"
  >("idle");
  let cathayOtpChannel = $state<"email" | "sms" | null>(null);
  let cathayVerificationExpiresAt = $state<string | null>(null);
  let cathayVerificationSecondsRemaining = $state<number | null>(null);
  let bankOperation = $state<"idle" | "captcha" | "sync" | "success">("idle");
  let bankCaptchaExpiresAt = $state<number | null>(null);
  let bankCaptchaSeconds = $state(0);
  let bankVerificationSubmitted = false;
  let bankCaptchaImage = $state("");
  let bankCaptcha = $state("");
  let bankCaptchaDigitCount = $state(6);
  let bankCaptchaKind = $state<"numeric" | "alphanumeric">("numeric");
  let megabankOtpStep = $state(false);
  let megabankOtpMessage = $state("");
  let megabankOtp = $state("");
  let megabankOtpExpiresAt = $state<number | null>(null);
  let megabankOtpSecondsRemaining = $state(0);
  const MEGABANK_OTP_WINDOW_MS = 3 * 60_000;
  let pendingSyncTarget = $state<SyncTarget>("default");
  let einvoiceSyncQueued = $state(false);
  let einvoiceSyncQueuedTimer: ReturnType<typeof setTimeout> | undefined;
  let einvoiceSyncPolling = $state<"awaiting-active" | "active" | null>(null);
  let einvoiceSyncPreviousLastRunAt = $state<string | null>(null);
  let einvoiceSyncPollingTimer: ReturnType<typeof setTimeout> | undefined;
  let tdccSyncQueued = $state(false);
  let tdccSyncQueuedTimer: ReturnType<typeof setTimeout> | undefined;
  let tdccSyncPolling = $state<"awaiting-active" | "active" | null>(null);
  let tdccSyncPreviousLastRunAt = $state<string | null>(null);
  let tdccSyncPollingTimer: ReturnType<typeof setTimeout> | undefined;
  // 手動同步是一個長請求；iPhone 鎖定畫面時 Safari 會中斷它（"Load failed"），但伺服器仍會跑完。
  // 這時改為輪詢同步工作狀態，等背景結果出來再更新畫面，不把連線中斷當成同步失敗。
  let interruptedSync = $state<"polling" | "timeout" | null>(null);
  let interruptedSyncPreviousLastRunAt: string | null = null;
  let interruptedSyncDeadline = 0;
  let interruptedSyncEnableSchedule = false;
  let interruptedSyncTimer: ReturnType<typeof setTimeout> | undefined;
  let syncStartLastRunAt: string | null = null;
  let syncStartJobKnown = false;
  let destroyed = false;
  const job = $derived(
    ($jobs.data ?? []).find(
      (j) => j.connectorId === connectorId && j.scope === "all",
    ),
  );
  const syncBusy = $derived(Boolean(job?.running && job.phase !== "stalled"));
  $effect(() => {
    if (!job?.running || destroyed) return;
    if (connectorId === "einvoice" && einvoiceSyncPolling === null)
      startEinvoiceSyncPolling();
    if (connectorId === "tdcc" && tdccSyncPolling === null)
      startTdccSyncPolling();
  });
  const browserBank = $derived(
    connectorId === "sinopac" ||
      connectorId === "taishin" ||
      connectorId === "obank" ||
      connectorId === "nextbank" ||
      connectorId === "firstbank" ||
      connectorId === "hncb" ||
      connectorId === "rakuten" ||
      connectorId === "kgibank" ||
      connectorId === "megabank",
  );
  const browserBankSessionAvailable = $derived(
    browserBank && Boolean($settings.data?.sessionAvailable),
  );
  const megabankOtpActive = $derived(
    connectorId === "megabank" && megabankOtpStep,
  );
  const tdccConnectionReady = $derived(
    connectorId === "tdcc" && Boolean($settings.data?.sessionAvailable),
  );
  const tdccCredentialsComplete = $derived(
    connectorId === "tdcc" && Boolean($settings.data?.credentialsComplete),
  );
  const cathayConnectionReady = $derived(
    connectorId === "cathaybk" && Boolean($settings.data?.sessionAvailable),
  );
  const cathayVerificationExpired = $derived(
    cathayVerificationSecondsRemaining !== null &&
      cathayVerificationSecondsRemaining <= 0,
  );
  const cathayProgressStep = $derived(
    cathayConnectionReady || cathayVerificationStep === "complete"
      ? "complete"
      : cathayVerificationExpired
        ? "credentials"
        : cathayVerificationStep === "sms"
          ? "sms"
          : cathayVerificationStep === "choose" ||
              cathayVerificationStep === "email"
            ? "email"
            : "credentials",
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
        if (values[key] === undefined) values[key] = String(value);
      }
      if (connectorId === "cathaybk" && result.data) {
        if (result.data.sessionAvailable) {
          cathayVerificationStep = "complete";
          cathayVerificationExpiresAt = null;
          cathayVerificationSecondsRemaining = null;
        } else if (result.data.verificationPending) {
          cathayOtpChannel = result.data.verificationChannel ?? null;
          cathayVerificationStep = cathayOtpChannel ?? "choose";
          cathayVerificationExpiresAt =
            result.data.verificationExpiresAt ?? null;
          updateCathayVerificationCountdown();
        } else if (result.data.verificationExpiresAt) {
          cathayOtpChannel = null;
          cathayVerificationStep = "choose";
          cathayVerificationExpiresAt = result.data.verificationExpiresAt;
          updateCathayVerificationCountdown();
        } else if (cathayVerificationStep === "complete") {
          cathayVerificationStep = "idle";
        }
      }
    }),
  );
  onMount(() => {
    const timer = setInterval(() => {
      updateCathayVerificationCountdown();
      bankCaptchaSeconds = bankCaptchaExpiresAt
        ? Math.max(0, Math.ceil((bankCaptchaExpiresAt - Date.now()) / 1000))
        : 0;
      updateMegabankOtpCountdown();
    }, 1_000);
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        interruptedSync === "polling"
      ) {
        clearTimeout(interruptedSyncTimer);
        void pollInterruptedSync();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  });
  onDestroy(() => {
    destroyed = true;
    stopInterruptedSyncPolling();
    clearTimeout(einvoiceSyncQueuedTimer);
    stopEinvoiceSyncPolling();
    clearTimeout(tdccSyncQueuedTimer);
    stopTdccSyncPolling();
  });

  const save = createMutation({
    mutationFn: (config: Record<string, unknown>) => {
      if (!Object.keys(config).length) throw new Error("請先填寫欄位再儲存。");
      return api.put(`/api/connectors/${connectorId}/settings`, { config });
    },
    onSuccess: () => {
      error = "";
      if (connectorId === "cathaybk") resetCathayVerification();
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
    onMutate: () => ({
      enableSchedule: shouldEnableScheduleAfterFirstSync(connectorId, job),
    }),
    mutationFn: async (target: SyncTarget) => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      if (browserBank) {
        if (connectorId === "nextbank") bankOperation = "sync";
        bankCaptchaImage = "";
        bankCaptcha = "";
      }
      const path =
        connectorId === "tdcc" && target !== "default"
          ? `/api/connectors/${connectorId}/sync/${target}`
          : `/api/connectors/${connectorId}/sync`;
      pendingSyncTarget = target;
      // 送出前的 lastRunAt 是請求中斷時分辨背景結果的基準；狀態尚未載入時沒有基準。
      syncStartJobKnown = Boolean(job);
      syncStartLastRunAt = job?.lastRunAt ?? null;
      const runSync = () =>
        connectorId === "einvoice" || connectorId === "tdcc"
          ? api.post<QueuedSyncResponse>(path, {})
          : api.post(path);
      try {
        return await runSync();
      } catch (errorValue) {
        if (
          connectorId === "cathaybk" &&
          errorValue instanceof ApiRequestError &&
          errorValue.code === "CATHAY_OTP_SESSION_EXPIRED"
        ) {
          return runSync();
        }
        throw errorValue;
      }
    },
    onSuccess: (_data, _target, context) => {
      error = "";
      if (connectorId === "nextbank") bankOperation = "success";
      if (connectorId === "cathaybk") {
        resetCathayVerification();
        cathayVerificationStep = "complete";
        qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
      }
      if (connectorId === "einvoice") {
        showEinvoiceSyncQueued();
        startEinvoiceSyncPolling();
        return;
      }
      if (connectorId === "tdcc") {
        showTdccSyncQueued();
        startTdccSyncPolling();
        tdccSetupStep = "complete";
        return;
      }
      refreshAfterManualSync(context.enableSchedule);
    },
    onError: (e, _target, context) => {
      if (isRequestInterrupted(e)) {
        startInterruptedSyncPolling(context?.enableSchedule ?? false);
        return;
      }
      if (handleTdccVerificationRequired(e)) return;
      if (handleCathayVerificationRequired(e)) return;
      if (connectorId === "megabank" && isMegabankOtpRequired(e)) {
        enterMegabankOtp(
          e instanceof Error
            ? e.message
            : "兆豐銀行已寄出簡訊驗證碼，請於三分鐘內輸入。",
        );
        qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
        return;
      }
      error = e instanceof Error ? e.message : "同步失敗";
      if (browserBank && isManualCaptchaRequired(e)) {
        // 自動辨識失敗：直接取得人工驗證碼，不再重試自動登入
        $prepareBrowserBank.mutate();
      } else if (needsNextbankCaptcha(connectorId, e)) {
        $prepareBrowserBank.mutate();
      }
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
      if (connectorId === "nextbank") bankOperation = "captcha";
      bankCaptchaImage = "";
      bankCaptcha = "";
      error = "";
      return api.post<{
        captchaImage: string;
        expiresAt: string;
        digitCount?: number;
        captchaLength?: number;
        captchaKind?: "numeric" | "alphanumeric";
      }>(`/api/connectors/${connectorId}/captcha`);
    },
    onSuccess: (data) => {
      error = "";
      bankCaptcha = "";
      if (!data.captchaImage || !Number.isFinite(Date.parse(data.expiresAt))) {
        error = "未取得有效驗證碼，請重新取得圖片。";
        return;
      }
      bankCaptchaImage = data.captchaImage;
      bankCaptchaExpiresAt = Date.parse(data.expiresAt);
      bankCaptchaSeconds = Math.max(
        0,
        Math.ceil((bankCaptchaExpiresAt - Date.now()) / 1000),
      );
      bankCaptchaDigitCount = data.captchaLength ?? data.digitCount ?? 6;
      bankCaptchaKind = data.captchaKind ?? "numeric";
    },
    onError: (e) => (error = e instanceof Error ? e.message : "取得驗證碼失敗"),
  });
  const verifyBrowserBank = createMutation({
    onMutate: () => ({
      enableSchedule: shouldEnableScheduleAfterFirstSync(connectorId, job),
    }),
    mutationFn: () => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      if (connectorId === "nextbank") bankOperation = "sync";
      bankVerificationSubmitted = false;
      if (!bankCaptchaExpiresAt || Date.now() >= bankCaptchaExpiresAt)
        throw new Error("驗證碼已過期，請重新取得圖片。");
      const pattern =
        bankCaptchaKind === "alphanumeric"
          ? new RegExp(`^[A-Za-z0-9]{${bankCaptchaDigitCount}}$`)
          : new RegExp(`^\\d{${bankCaptchaDigitCount}}$`);
      if (!pattern.test(bankCaptcha.trim()))
        throw new Error(
          `請輸入圖片中的 ${bankCaptchaDigitCount} 位${bankCaptchaKind === "alphanumeric" ? "英數字" : "數字"}驗證碼。`,
        );
      bankVerificationSubmitted = true;
      return api.post(`/api/connectors/${connectorId}/sync`, {
        captcha: bankCaptcha.trim(),
      });
    },
    onSuccess: (_data, _variables, context) => {
      error = "";
      bankCaptcha = "";
      bankCaptchaImage = "";
      if (connectorId === "nextbank") bankOperation = "success";
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
      qc.invalidateQueries({ queryKey: queryKeys.summary });
      invalidateLatestSyncReport();
      qc.invalidateQueries({ queryKey: queryKeys.bank });
      qc.invalidateQueries({ queryKey: queryKeys.bills });
      enableScheduleAfterSuccessfulSync(context.enableSchedule);
    },
    onError: (e) => {
      if (needsNextbankCaptcha(connectorId, e)) {
        $prepareBrowserBank.mutate();
        qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
        return;
      }
      if (connectorId === "megabank" && isMegabankOtpRequired(e)) {
        enterMegabankOtp(
          e instanceof Error
            ? e.message
            : "兆豐銀行已寄出簡訊驗證碼，請於三分鐘內輸入。",
        );
        qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
        return;
      }
      const failure = browserCaptchaFailure(e);
      error = failure.message;
      if (failure.sessionInvalidated || bankVerificationSubmitted) {
        bankCaptcha = "";
        bankCaptchaImage = "";
        qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
      }
    },
  });
  const verifyMegabankOtp = createMutation({
    onMutate: () => ({
      enableSchedule: shouldEnableScheduleAfterFirstSync(connectorId, job),
    }),
    mutationFn: () => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      const trimmed = megabankOtp.trim();
      if (!/^\d{4,8}$/.test(trimmed))
        throw new Error("請輸入簡訊收到的 4-8 位數字驗證碼。");
      return api.post(`/api/connectors/megabank/sync`, { otp: trimmed });
    },
    onSuccess: (_data, _variables, context) => {
      error = "";
      resetMegabankOtp();
      bankCaptcha = "";
      bankCaptchaImage = "";
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
      qc.invalidateQueries({ queryKey: queryKeys.summary });
      invalidateLatestSyncReport();
      qc.invalidateQueries({ queryKey: queryKeys.bank });
      qc.invalidateQueries({ queryKey: queryKeys.bills });
      enableScheduleAfterSuccessfulSync(context.enableSchedule);
    },
    onError: (e) => {
      if (megabankOtpFailure(e) === "retry") {
        megabankOtp = "";
        error =
          e instanceof Error
            ? e.message
            : "兆豐銀行簡訊驗證碼不正確，請重新輸入。";
        return;
      }
      const failure = browserCaptchaFailure(e);
      resetMegabankOtp();
      error = failure.message;
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
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

  const requestCathayOtp = createMutation({
    mutationFn: (channel: "email" | "sms") => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      cathayOtpChannel = channel;
      return api.post(`/api/connectors/${connectorId}/sync`, {
        otpChannel: channel,
      });
    },
    onSuccess: () => {
      if (cathayOtpChannel) cathayVerificationStep = cathayOtpChannel;
      error = "";
    },
    onError: (e) => {
      if (handleCathayVerificationRequired(e)) return;
      error = e instanceof Error ? e.message : "寄送驗證碼失敗";
    },
  });

  const verifyCathayOtp = createMutation({
    mutationFn: () => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      if (!otp.trim()) throw new Error("請先輸入驗證碼。");
      if (!cathayOtpChannel) throw new Error("請先選擇驗證方式。");
      return api.post(`/api/connectors/${connectorId}/sync`, {
        otp: otp.trim(),
        otpChannel: cathayOtpChannel,
      });
    },
    onSuccess: () => finishCathayVerification(),
    onError: (e) => {
      if (handleCathayVerificationRequired(e)) {
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

  function handleCathayVerificationRequired(errorValue: unknown) {
    if (!(errorValue instanceof ApiRequestError)) return false;
    if (errorValue.code === "CATHAY_OTP_CHANNEL_REQUIRED") {
      error = "";
      otp = "";
      cathayOtpChannel = null;
      cathayVerificationStep = "choose";
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      return true;
    }
    if (
      errorValue.code === "CATHAY_EMAIL_OTP_REQUIRED" ||
      errorValue.code === "CATHAY_SMS_OTP_REQUIRED"
    ) {
      error = "";
      otp = "";
      cathayOtpChannel =
        errorValue.code === "CATHAY_SMS_OTP_REQUIRED" ? "sms" : "email";
      cathayVerificationStep = cathayOtpChannel;
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      return true;
    }
    if (errorValue.code === "CATHAY_OTP_SESSION_EXPIRED") {
      resetCathayVerification();
      error = errorValue.message;
      return true;
    }
    if (errorValue.code === "CATHAY_OTP_INVALID") {
      otp = "";
      error = errorValue.message;
      return true;
    }
    return false;
  }

  function resetCathayVerification() {
    if (connectorId !== "cathaybk") return;
    otp = "";
    cathayOtpChannel = null;
    cathayVerificationExpiresAt = null;
    cathayVerificationSecondsRemaining = null;
    cathayVerificationStep = "idle";
    $requestCathayOtp.reset();
    $verifyCathayOtp.reset();
  }

  function finishCathayVerification() {
    error = "";
    resetCathayVerification();
    cathayVerificationStep = "complete";
    qc.invalidateQueries({
      queryKey: queryKeys.connectorSettings(connectorId),
    });
    qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    qc.invalidateQueries({ queryKey: queryKeys.summary });
    invalidateLatestSyncReport();
    qc.invalidateQueries({ queryKey: queryKeys.bank });
    qc.invalidateQueries({ queryKey: queryKeys.bills });
  }

  function updateCathayVerificationCountdown() {
    if (!cathayVerificationExpiresAt) {
      cathayVerificationSecondsRemaining = null;
      return;
    }
    const expiresAt = Date.parse(cathayVerificationExpiresAt);
    cathayVerificationSecondsRemaining = Number.isFinite(expiresAt)
      ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000))
      : 0;
  }

  function cathayCountdownLabel(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function restartCathayVerification() {
    resetCathayVerification();
    error = "";
    $sync.mutate("default");
  }

  function enterMegabankOtp(message: string) {
    error = "";
    bankCaptcha = "";
    bankCaptchaImage = "";
    megabankOtp = "";
    megabankOtpMessage = message;
    megabankOtpStep = true;
    megabankOtpExpiresAt = Date.now() + MEGABANK_OTP_WINDOW_MS;
    megabankOtpSecondsRemaining = Math.ceil(MEGABANK_OTP_WINDOW_MS / 1_000);
  }

  function resetMegabankOtp() {
    megabankOtpStep = false;
    megabankOtp = "";
    megabankOtpMessage = "";
    megabankOtpExpiresAt = null;
    megabankOtpSecondsRemaining = 0;
    $verifyMegabankOtp.reset();
  }

  function updateMegabankOtpCountdown() {
    if (!megabankOtpStep || megabankOtpExpiresAt === null) return;
    megabankOtpSecondsRemaining = Math.max(
      0,
      Math.ceil((megabankOtpExpiresAt - Date.now()) / 1_000),
    );
    if (megabankOtpSecondsRemaining <= 0) {
      error = "兆豐簡訊驗證碼已逾時，請重新取得驗證碼。";
      resetMegabankOtp();
    }
  }

  function enableScheduleAfterSuccessfulSync(eligible: boolean) {
    if (eligible && job && !job.enabled) {
      $updateJob.mutate({ enabled: true });
    }
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
    invalidateLatestSyncReport();
    qc.invalidateQueries({ queryKey: queryKeys.investments });
    qc.invalidateQueries({ queryKey: queryKeys.investmentTransactions });
    qc.invalidateQueries({ queryKey: queryKeys.bank });
    showTdccSyncQueued();
    startTdccSyncPolling();
  }

  function buildConfig() {
    const entries: Array<[string, string | number]> = [];
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
  function showEinvoiceSyncQueued() {
    einvoiceSyncQueued = true;
    clearTimeout(einvoiceSyncQueuedTimer);
    einvoiceSyncQueuedTimer = setTimeout(() => {
      einvoiceSyncQueued = false;
    }, 5_000);
  }

  function showTdccSyncQueued() {
    tdccSyncQueued = true;
    clearTimeout(tdccSyncQueuedTimer);
    tdccSyncQueuedTimer = setTimeout(() => {
      tdccSyncQueued = false;
    }, 5_000);
  }
  function refreshAfterManualSync(enableSchedule: boolean) {
    invalidateLatestSyncReport();
    qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    qc.invalidateQueries({ queryKey: queryKeys.summary });
    enableScheduleAfterSuccessfulSync(enableSchedule);
    qc.invalidateQueries({ queryKey: queryKeys.exchangeRates });
    if (
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
  }
  function startInterruptedSyncPolling(enableSchedule: boolean) {
    error = "";
    if (!syncStartJobKnown) {
      // 沒有送出前的基準，無法分辨背景結果是否屬於這次同步，不猜測。
      interruptedSync = "timeout";
      qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
      return;
    }
    interruptedSync = "polling";
    interruptedSyncEnableSchedule = enableSchedule;
    interruptedSyncPreviousLastRunAt = syncStartLastRunAt;
    interruptedSyncDeadline = Date.now() + 5 * 60_000;
    clearTimeout(interruptedSyncTimer);
    void pollInterruptedSync();
  }
  function stopInterruptedSyncPolling() {
    clearTimeout(interruptedSyncTimer);
    interruptedSyncTimer = undefined;
  }
  async function pollInterruptedSync() {
    const syncJobs = await qc
      .fetchQuery({ ...syncJobsQuery(() => api), staleTime: 0 })
      .catch(() => undefined);
    if (destroyed || interruptedSync !== "polling") return;
    const current = syncJobs?.find(
      (syncJob) =>
        syncJob.connectorId === connectorId && syncJob.scope === "all",
    );
    if (
      current &&
      !current.running &&
      current.lastRunAt !== interruptedSyncPreviousLastRunAt
    ) {
      interruptedSync = null;
      stopInterruptedSyncPolling();
      if (current.lastStatus === "success") {
        refreshAfterManualSync(interruptedSyncEnableSchedule);
      } else {
        error = current.lastError?.trim() || "同步失敗";
        if (browserBank)
          qc.invalidateQueries({
            queryKey: queryKeys.connectorSettings(connectorId),
          });
      }
      return;
    }
    if (Date.now() > interruptedSyncDeadline) {
      interruptedSync = "timeout";
      stopInterruptedSyncPolling();
      return;
    }
    interruptedSyncTimer = setTimeout(
      () => void pollInterruptedSync(),
      document.visibilityState === "visible" ? 3_000 : 10_000,
    );
  }
  function startEinvoiceSyncPolling() {
    einvoiceSyncPolling = "awaiting-active";
    einvoiceSyncPreviousLastRunAt = job?.lastRunAt ?? null;
    clearTimeout(einvoiceSyncPollingTimer);
    void pollEinvoiceSyncJob();
  }
  function stopEinvoiceSyncPolling() {
    einvoiceSyncPolling = null;
    clearTimeout(einvoiceSyncPollingTimer);
    einvoiceSyncPollingTimer = undefined;
  }
  async function pollEinvoiceSyncJob() {
    const syncJobs = await qc
      .fetchQuery({ ...syncJobsQuery(() => api), staleTime: 0 })
      .catch(() => undefined);
    if (!einvoiceSyncPolling || destroyed) return;
    const einvoiceJob = syncJobs?.find(
      (syncJob) =>
        syncJob.connectorId === "einvoice" && syncJob.scope === "all",
    );
    if (einvoiceJob?.running) {
      einvoiceSyncPolling = "active";
    } else if (
      einvoiceSyncPolling === "active" ||
      einvoiceJob?.lastRunAt !== einvoiceSyncPreviousLastRunAt
    ) {
      const completedSuccessfully = einvoiceJob?.lastStatus === "success";
      stopEinvoiceSyncPolling();
      if (completedSuccessfully) {
        invalidateLatestSyncReport();
        qc.invalidateQueries({ queryKey: queryKeys.summary });
        qc.invalidateQueries({ queryKey: queryKeys.invoices });
      }
      return;
    }
    einvoiceSyncPollingTimer = setTimeout(() => {
      void pollEinvoiceSyncJob();
    }, 2_000);
  }
  function startTdccSyncPolling() {
    tdccSyncPolling = "awaiting-active";
    tdccSyncPreviousLastRunAt = job?.lastRunAt ?? null;
    clearTimeout(tdccSyncPollingTimer);
    void pollTdccSyncJob();
  }
  function stopTdccSyncPolling() {
    tdccSyncPolling = null;
    clearTimeout(tdccSyncPollingTimer);
    tdccSyncPollingTimer = undefined;
  }
  async function pollTdccSyncJob() {
    const syncJobs = await qc
      .fetchQuery({ ...syncJobsQuery(() => api), staleTime: 0 })
      .catch(() => undefined);
    if (!tdccSyncPolling || destroyed) return;
    const tdccJob = syncJobs?.find(
      (syncJob) => syncJob.connectorId === "tdcc" && syncJob.scope === "all",
    );
    if (tdccJob?.running) {
      tdccSyncPolling = "active";
    } else if (
      tdccJob &&
      (tdccSyncPolling === "active" ||
        tdccJob.lastRunAt !== tdccSyncPreviousLastRunAt)
    ) {
      const status = tdccJob?.lastStatus;
      stopTdccSyncPolling();
      if (status === "success") {
        invalidateLatestSyncReport();
        qc.invalidateQueries({ queryKey: queryKeys.summary });
        qc.invalidateQueries({ queryKey: queryKeys.connectorSettings("tdcc") });
        qc.invalidateQueries({ queryKey: queryKeys.investments });
        qc.invalidateQueries({ queryKey: queryKeys.investmentTransactions });
        qc.invalidateQueries({ queryKey: queryKeys.bank });
      } else if (status === "failed" || status === "needs_user_action") {
        error = tdccJob?.lastError ?? "集保同步失敗，請重新驗證。";
      }
      return;
    }
    tdccSyncPollingTimer = setTimeout(() => {
      void pollTdccSyncJob();
    }, 2_000);
  }
  function invalidateLatestSyncReport() {
    qc.invalidateQueries({ queryKey: queryKeys.latestSyncReport });
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
          disabled={demoMode ||
            $sync.isPending ||
            $verifyOtp.isPending ||
            tdccSyncPolling !== null}
          onclick={() => $sync.mutate("default")}
          ><RefreshCw
            class={$sync.isPending ? "size-4 animate-spin" : "size-4"}
          />{$sync.isPending
            ? "同步中…"
            : tdccSyncQueued
              ? "已排入同步"
              : tdccSyncPolling
                ? "同步中…"
                : "同步"}</Button
        >
      {:else if connectorId === "tdcc"}
        <span
          class="inline-flex items-center gap-1.5 rounded-full border border-steel/20 bg-steel/[0.06] px-3 py-1.5 text-sm font-semibold text-steel"
        >
          <ShieldCheck class="size-3.5" />等待完成身分驗證
        </span>
      {:else if connectorId === "nextbank"}
        <span class="text-sm text-muted-foreground"
          >在下方查看進度與同步帳戶</span
        >
      {:else if browserBank}
        {#if browserBankSessionAvailable}
          <Button
            size="sm"
            disabled={demoMode ||
              $sync.isPending ||
              $verifyBrowserBank.isPending ||
              megabankOtpActive}
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
              $verifyBrowserBank.isPending ||
              megabankOtpActive}
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
              $verifyBrowserBank.isPending ||
              megabankOtpActive}
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
              $verifyBrowserBank.isPending ||
              megabankOtpActive}
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
          disabled={demoMode ||
            $sync.isPending ||
            (connectorId === "einvoice" && einvoiceSyncPolling !== null) ||
            (connectorId === "cathaybk" &&
              !cathayVerificationExpired &&
              (cathayVerificationStep === "choose" ||
                cathayVerificationStep === "email" ||
                cathayVerificationStep === "sms"))}
          onclick={() => {
            error = "";
            interruptedSync = null;
            stopInterruptedSyncPolling();
            $sync.mutate("default");
          }}
          ><RefreshCw
            class={$sync.isPending ? "size-4 animate-spin" : "size-4"}
          />{$sync.isPending
            ? "同步中…"
            : connectorId === "einvoice" && einvoiceSyncQueued
              ? "已排入同步"
              : connectorId === "einvoice" && einvoiceSyncPolling
                ? "同步中…"
                : "同步"}</Button
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
    <ConnectionProgress
      step={tdccSetupStep}
      connectionReady={tdccConnectionReady}
      source="tdcc"
    />
  {:else if connectorId === "cathaybk"}
    <ConnectionProgress
      step={cathayProgressStep}
      connectionReady={cathayConnectionReady}
      source="cathaybk"
    />
  {:else if browserBank}
    {#if connectorId === "nextbank"}
      <section
        aria-label="同步進度"
        aria-live="polite"
        class="mt-3 rounded-xl border border-border bg-muted/40 p-4"
      >
        {#if !$settings.data?.credentialsComplete}
          <p class="font-semibold">先儲存帳密</p>
          <p class="mt-1 text-sm text-muted-foreground">
            請填寫下方連線憑證並儲存，再按「同步帳戶」。
          </p>
        {:else if $prepareBrowserBank.isPending}
          <p role="status" class="font-semibold">正在取得驗證碼圖片…</p>
          <p class="mt-1 text-sm">
            取得後會在下方顯示圖片與輸入欄，請勿重複點擊。
          </p>
        {:else if $sync.isPending || $verifyBrowserBank.isPending || syncBusy}
          <p role="status" class="font-semibold">正在登入並查詢帳戶…</p>
          <p class="mt-1 text-sm">尚未完成同步，請勿重複提交。</p>
        {:else if error}
          <p role="alert" class="font-semibold text-coral">
            {bankOperation === "captcha"
              ? "無法取得驗證碼"
              : "同步未完成"}：{error.includes("transport")
              ? "目前無法連線到銀行，這不代表帳密錯誤。請稍後再試；手動驗證無法解決連線問題。"
              : error}
          </p>
        {:else if bankOperation === "success"}
          <p role="status" class="font-semibold text-moss">
            同步成功，帳戶資料已更新。
          </p>
        {:else if bankCaptchaImage}
          <p class="font-semibold">
            {bankCaptchaSeconds > 0
              ? "請輸入下方圖片中的驗證碼"
              : "驗證碼已過期"}
          </p>
          <p class="mt-1 text-sm">
            {bankCaptchaSeconds > 0
              ? "填寫後按「驗證並同步」，目前尚未登入或同步。"
              : "請按下方「換一張」取得新圖片。"}
          </p>
        {:else if job?.lastStatus === "needs_user_action"}
          <p class="font-semibold">需要處理登入驗證</p>
          <p class="mt-1 text-sm">
            請查看最近失敗原因；若需手動輸入驗證碼，可按「改用手動驗證」。
          </p>
        {:else}
          <p class="font-semibold">可以開始同步</p>
          <p class="mt-1 text-sm text-muted-foreground">
            「同步帳戶」會自動處理登入與圖形驗證碼。只有辨識失敗，或你想自行輸入圖片內容時，才使用「改用手動驗證」。
          </p>
        {/if}
        {#if !bankCaptchaImage}
          <div class="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={demoMode ||
                !$settings.data?.credentialsComplete ||
                syncBusy ||
                $save.isPending ||
                $sync.isPending ||
                $prepareBrowserBank.isPending ||
                $verifyBrowserBank.isPending}
              onclick={() => {
                error = "";
                $sync.mutate("default");
              }}
            >
              <RefreshCw
                class={$sync.isPending || $verifyBrowserBank.isPending
                  ? "size-4 animate-spin"
                  : "size-4"}
              />
              {$sync.isPending || $verifyBrowserBank.isPending
                ? "同步中…"
                : "同步帳戶"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={demoMode ||
                !$settings.data?.credentialsComplete ||
                syncBusy ||
                $save.isPending ||
                $sync.isPending ||
                $prepareBrowserBank.isPending ||
                $verifyBrowserBank.isPending}
              onclick={() => $prepareBrowserBank.mutate()}
            >
              <KeyRound class="size-4" />{$prepareBrowserBank.isPending
                ? "取得驗證碼中…"
                : bankOperation === "captcha"
                  ? "重新取得驗證碼"
                  : "改用手動驗證"}
            </Button>
          </div>
        {/if}
        <p class="mt-3 border-t border-border pt-3 text-sm">
          最近同步結果：{bankOperation === "success"
            ? "成功"
            : bankOperation === "sync" && error
              ? "失敗"
              : job?.lastStatus === "success"
                ? "成功"
                : job?.lastStatus === "failed"
                  ? "失敗"
                  : job?.lastStatus === "needs_user_action"
                    ? "未完成，需要驗證"
                    : "尚未同步"}
        </p>
        {#if job?.lastRunAt}<p class="mt-1 text-sm text-muted-foreground">
            最近嘗試：{formatDateTime(job.lastRunAt)}
          </p>{/if}
        <p class="mt-1 text-sm text-muted-foreground">
          最近成功更新：{job?.lastSuccessAt
            ? formatDateTime(job.lastSuccessAt)
            : "尚無成功紀錄"}
        </p>
        {#if !error && bankOperation === "idle" && job?.lastStatus !== "success" && job?.lastError}<p
            class="mt-1 text-sm text-coral"
          >
            最近失敗原因：{job.lastError.includes("transport")
              ? "無法連線到銀行，請稍後再試。"
              : job.lastError}
          </p>{/if}
      </section>
    {/if}
    <BrowserBankConnectionHelp
      bankName={connectorId === "nextbank"
        ? "將來"
        : connectorId === "taishin"
          ? "台新"
          : connectorId === "obank"
            ? "王道"
            : connectorId === "hncb"
              ? "華南"
              : connectorId === "firstbank"
                ? "第一銀行"
                : connectorId === "kgibank"
                  ? "凱基"
                  : connectorId === "megabank"
                    ? "兆豐"
                    : connectorId === "rakuten"
                      ? "樂天"
                      : "永豐"}
      bind:captcha={bankCaptcha}
      captchaImage={bankCaptchaImage}
      digitCount={bankCaptchaDigitCount}
      captchaKind={bankCaptchaKind}
      preparing={$prepareBrowserBank.isPending}
      verifying={$verifyBrowserBank.isPending}
      syncing={$sync.isPending}
      expiresIn={connectorId === "nextbank" ? bankCaptchaSeconds : undefined}
      onVerify={() => {
        error = "";
        $verifyBrowserBank.mutate();
      }}
      onRefresh={() => $prepareBrowserBank.mutate()}
    />
  {/if}
  <div
    class={`mt-3 rounded-xl border border-ink/10 bg-paper p-3 text-sm ${(connectorId === "tdcc" && !tdccConnectionReady && !job?.running) || (connectorId === "cathaybk" && !cathayConnectionReady && cathayVerificationStep !== "complete") ? "hidden" : ""}`}
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink/70">
          <span class="font-semibold text-ink">
            自動同步：{job?.enabled ? "開" : "關"}
          </span>
          {#if browserBank && connectorId !== "nextbank"}<span
              >登入：{browserBankSessionAvailable
                ? "session 可自動續用"
                : "下次同步會自動驗證"}</span
            >{/if}
          {#if job && connectorId !== "nextbank"}<span
              >狀態：{job.phase === "stalled"
                ? "同步停滯，可重試"
                : job.running
                  ? job.phase === "queued"
                    ? "等待同步"
                    : job.phase === "initializing"
                      ? "正在登入"
                      : job.phase === "bank"
                        ? "正在查詢銀行資料"
                        : job.phase === "trades"
                          ? "正在查詢投資交易"
                          : job.phase === "promoting" || job.phase === "promote"
                            ? "正在儲存結果"
                            : "同步中"
                  : job.lastStatus === "success"
                    ? "正常"
                    : job.lastStatus === "failed"
                      ? "失敗"
                      : job.lastStatus === "needs_user_action"
                        ? "需要處理"
                        : "尚未同步"}</span
            >{/if}
        </div>
        {#if job?.running}
          <div class="mt-1 text-sm text-muted-foreground" role="status">
            {#if job.lastProgressAt}<p>
                最近狀態更新：{formatDateTime(job.lastProgressAt)}
              </p>{/if}
            {#if job.phase === "stalled"}<p>
                工作已停止更新，系統會自動恢復，也可按下方「重試同步」。
              </p>{/if}
          </div>
        {/if}
        {#if job?.lastRunAt && connectorId !== "nextbank"}
          <p class="mt-1 text-sm text-muted-foreground">
            最近嘗試：{formatDateTime(job.lastRunAt)}
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
    {#if job?.phase === "stalled" && (connectorId === "einvoice" || connectorId === "tdcc")}
      <Button
        size="sm"
        variant="outline"
        disabled={demoMode || $sync.isPending}
        onclick={() =>
          $sync.mutate(
            connectorId === "tdcc" &&
              (job.lockScope === "bank" ||
                job.lockScope === "investments" ||
                job.lockScope === "trades")
              ? job.lockScope
              : "default",
          )}>重試同步</Button
      >
    {/if}

    {#if connectorId === "nextbank"}
      <p class="mt-2 text-sm text-muted-foreground">
        {job?.enabled
          ? "依下方排程自動嘗試同步；結果請看同步進度。"
          : "目前只會在你手動操作時同步。"}
      </p>
    {/if}
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
    {#if connectorId !== "nextbank" && (error || ((job?.lastStatus === "failed" || job?.lastStatus === "needs_user_action") && !bankCaptchaImage))}<p
        class="mt-2 text-sm text-coral"
      >
        {error
          ? `本次同步：${error}`
          : job?.lastError?.trim()
            ? `上次同步：${job.lastError}`
            : "上次同步失敗，但未取得錯誤原因。"}
      </p>{/if}
    {#if interruptedSync}<p
        class="mt-2 text-sm text-muted-foreground"
        role="status"
      >
        {interruptedSync === "polling"
          ? "畫面關閉或網路中斷，同步仍在背景進行，完成後會自動更新結果。"
          : "仍無法確認同步結果，請稍後重新整理頁面查看。"}
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
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="grid gap-3 p-4">
        {#each fields as field (field.key)}
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
              name={`tfh-${connectorId}-${field.key}`}
              autocomplete={field.type === "password" ? "new-password" : "off"}
              autocapitalize="none"
              spellcheck={false}
              readonly={!focusedCredentialKeys[field.key]}
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              placeholder={storedCredential && !hasReplacement
                ? "••••••••　已安全儲存"
                : field.placeholder}
              value={String(values[field.key] ?? "")}
              onfocus={() => (focusedCredentialKeys[field.key] = true)}
              oninput={(e: Event) =>
                (values[field.key] = (
                  e.currentTarget as HTMLInputElement
                ).value)}
            />
          </label>
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
            disabled={$connectTdcc.isPending ||
              $verifyOtp.isPending ||
              demoMode}
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
    </form>
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
  {#if connectorId === "cathaybk" && (cathayVerificationStep === "choose" || cathayVerificationStep === "email" || cathayVerificationStep === "sms")}
    <div
      class="mt-3 overflow-hidden rounded-xl border border-steel/20 bg-steel/[0.055]"
    >
      <div class="flex items-start gap-3 border-b border-steel/15 px-4 py-3">
        <span
          class="grid size-9 shrink-0 place-items-center rounded-full bg-steel/10 text-steel"
        >
          {#if cathayVerificationStep === "sms"}<Smartphone
              class="size-4.5"
            />{:else}<Mail class="size-4.5" />{/if}
        </span>
        <div>
          <p class="text-sm font-semibold text-ink">
            {cathayVerificationExpired
              ? "驗證工作階段已逾時"
              : cathayVerificationStep === "choose"
                ? "需要額外驗證"
                : cathayVerificationStep === "sms"
                  ? "簡訊驗證碼已寄出"
                  : "Email 驗證碼已寄出"}
          </p>
          <p class="mt-0.5 text-sm leading-relaxed text-ink/60">
            {cathayVerificationExpired
              ? "為避免持續占用 Browser Run，驗證工作階段已關閉，請重新同步。"
              : cathayVerificationStep === "choose"
                ? "國泰世華要求額外驗證，請選擇驗證碼寄送方式。"
                : cathayVerificationStep === "sms"
                  ? "請輸入國泰世華寄到手機的驗證碼。"
                  : "請查看國泰世華帳號登記的電子信箱，也別忘了檢查垃圾郵件匣。"}
          </p>
          {#if !cathayVerificationExpired && cathayVerificationSecondsRemaining !== null}
            <p class="mt-1 text-xs font-semibold text-steel" aria-live="polite">
              請於 {cathayCountdownLabel(cathayVerificationSecondsRemaining)}
              內完成驗證
            </p>
          {/if}
        </div>
      </div>
      {#if cathayVerificationExpired}
        <div class="p-4">
          <Button
            size="sm"
            disabled={$sync.isPending}
            onclick={restartCathayVerification}
            ><RefreshCw
              class={$sync.isPending ? "size-4 animate-spin" : "size-4"}
            />{$sync.isPending ? "重新連線中…" : "重新開始驗證"}</Button
          >
        </div>
      {:else if cathayVerificationStep === "choose"}
        <div class="flex flex-wrap gap-2 p-4">
          <Button
            size="sm"
            disabled={$requestCathayOtp.isPending || $verifyCathayOtp.isPending}
            onclick={() => {
              error = "";
              $requestCathayOtp.mutate("email");
            }}
            ><Mail class="size-4" />{$requestCathayOtp.isPending &&
            cathayOtpChannel === "email"
              ? "寄送中…"
              : "使用 Email"}</Button
          >
          <Button
            size="sm"
            variant="outline"
            disabled={$requestCathayOtp.isPending || $verifyCathayOtp.isPending}
            onclick={() => {
              error = "";
              $requestCathayOtp.mutate("sms");
            }}
            ><Smartphone class="size-4" />{$requestCathayOtp.isPending &&
            cathayOtpChannel === "sms"
              ? "寄送中…"
              : "使用簡訊"}</Button
          >
        </div>
      {:else}
        <div class="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label class="grid gap-1.5 text-sm font-medium">
            驗證碼後 6 位數字
            <Input
              class="bg-white/80 tracking-[0.2em]"
              inputmode="numeric"
              autocomplete="one-time-code"
              placeholder="例如 310307（不含英文前綴）"
              bind:value={otp}
            />
          </label>
          <Button
            class="self-end"
            size="sm"
            disabled={$verifyCathayOtp.isPending || !otp.trim()}
            onclick={() => {
              error = "";
              $verifyCathayOtp.mutate();
            }}
            ><ShieldCheck class="size-4" />{$verifyCathayOtp.isPending
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
              cathayOtpChannel = null;
              cathayVerificationStep = "choose";
              $requestCathayOtp.reset();
            }}>返回選擇驗證方式</button
          >
          <Button
            size="sm"
            variant="outline"
            disabled={$requestCathayOtp.isPending || !cathayOtpChannel}
            onclick={() => {
              error = "";
              $requestCathayOtp.mutate(cathayOtpChannel!);
            }}
            ><RefreshCw class="size-4" />{$requestCathayOtp.isPending
              ? "重新寄送中…"
              : cathayOtpChannel === "sms"
                ? "重新寄送簡訊"
                : "重新寄送 Email"}</Button
          >
        </div>
      {/if}
    </div>
  {/if}
  {#if megabankOtpActive}
    <div
      class="mt-3 overflow-hidden rounded-xl border border-steel/20 bg-steel/[0.055]"
    >
      <div class="flex items-start gap-3 border-b border-steel/15 px-4 py-3">
        <span
          class="grid size-9 shrink-0 place-items-center rounded-full bg-steel/10 text-steel"
        >
          <Smartphone class="size-4.5" />
        </span>
        <div>
          <p class="text-sm font-semibold text-fg">簡訊驗證碼已寄出</p>
          <p class="mt-0.5 text-sm leading-relaxed text-fg/60">
            {megabankOtpMessage}
          </p>
          <p class="mt-1 text-xs font-semibold text-steel" aria-live="polite">
            請於 {cathayCountdownLabel(megabankOtpSecondsRemaining)} 內完成驗證
          </p>
        </div>
      </div>
      <div class="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label class="grid gap-1.5 text-sm font-medium">
          簡訊驗證碼
          <Input
            class="bg-card/80 tracking-[0.2em]"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern={"[0-9]{4,8}"}
            maxlength={8}
            placeholder="4-8 位數字驗證碼"
            bind:value={megabankOtp}
          />
        </label>
        <Button
          class="self-end"
          size="sm"
          disabled={$verifyMegabankOtp.isPending ||
            !/^\d{4,8}$/.test(megabankOtp.trim())}
          onclick={() => {
            error = "";
            $verifyMegabankOtp.mutate();
          }}
          ><ShieldCheck class="size-4" />{$verifyMegabankOtp.isPending
            ? "驗證並同步中…"
            : "驗證並同步"}</Button
        >
      </div>
      <div
        class="flex flex-wrap items-center justify-end gap-2 border-t border-steel/15 px-4 py-2.5"
      >
        <button
          type="button"
          class="text-sm font-semibold text-fg/55 underline-offset-4 hover:text-fg hover:underline"
          onclick={() => {
            error = "";
            resetMegabankOtp();
          }}>取消</button
        >
      </div>
    </div>
  {/if}
  {#if (connectorId === "tdcc" || connectorId === "cathaybk") && error}<p
      class="mt-3 rounded-lg border border-coral/20 bg-coral/[0.06] px-3 py-2 text-sm font-medium text-coral"
    >
      {error}
    </p>{/if}
  <p class="mt-3 text-sm text-ink/50">
    {connectorId === "nextbank"
      ? "將來銀行同步會嘗試辨識圖形驗證碼；需要時使用手動驗證。每次查詢後登出，投資持倉尚未接入。"
      : connectorId === "sinopac"
        ? "永豐 session 失效時會由 Gemma 4 自動辨識並登入，連續三次失敗後才需人工驗證。"
        : connectorId === "obank"
          ? "王道手動與排程同步都會在必要時接管其他登入中的裝置；同步會直接使用 App API，並由 Gemma 4 自動辨識四位英數驗證碼。"
          : connectorId === "firstbank"
            ? "第一銀行網銀 session 失效時會自動辨識圖形驗證碼並登入；也可改用人工輸入。"
            : connectorId === "kgibank"
              ? "凱基每次同步都會自動辨識 6 位數圖形驗證碼，連續失敗後可改用人工輸入。同一帳號僅允許單一登入，同步會登出行動銀行 App；同步完成後會自動登出網銀。"
              : connectorId === "tdcc"
                ? "排程同步不會在背景寄送驗證碼；登入失效時會標記為需要重新驗證。"
                : connectorId === "cathaybk"
                  ? "首次驗證會加入信任裝置；信任失效時需在手動同步中重新取得驗證碼。"
                  : connectorId === "megabank"
                    ? "兆豐同步直接使用 App API，以一般帳密登入並辨識五位數圖形驗證碼；也可改用人工輸入。"
                    : connectorId === "rakuten"
                      ? "樂天網銀驗證碼會先以 Workers AI 自動辨識，失敗時改由人工輸入；每次同步都重新登入，結束時登出，不保留 session。"
                      : "輸入完帳號密碼後，請先按「儲存設定」，再按「同步」。"}
  </p>
</Card>
