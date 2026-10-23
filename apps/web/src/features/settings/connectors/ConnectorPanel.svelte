<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
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
  import CaptchaBankConnectionHelp from "./CaptchaBankConnectionHelp.svelte";
  import ConnectionProgress from "./ConnectionProgress.svelte";
  import CtbcVerification from "./CtbcVerification.svelte";
  import Card from "@/shared/ui/Card.svelte";
  import Button from "@/shared/ui/Button.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import TimePicker from "@/shared/ui/TimePicker.svelte";
  import {
    connectorCatalog,
    type ConnectorCapability,
  } from "@taiwan-fin-hub/shared";
  import WeekdayPicker from "../components/WeekdayPicker.svelte";
  import {
    formatScheduleWeekdays,
    syncIntervalLabel,
    syncIntervalOptions,
  } from "../model/schedule";
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
    ConnectorId,
    QueuedSyncResponse,
    SyncJobRow,
    SyncTarget,
  } from "@/data/connectors/types";
  import { formatDateTime } from "@/shared/format/financial";
  import {
    captchaBankFailure,
    isManualCaptchaRequired,
    isBankOtpRequired,
    megabankOtpFailure,
    needsNextbankCaptcha,
  } from "./captcha-bank";

  /** 非驗證碼銀行的底部說明；驗證碼銀行的說明在 CaptchaBankConnectionHelp。 */
  const CONNECTOR_NOTES: Partial<Record<ConnectorId, string>> = {
    tdcc: "排程同步不會在背景寄送驗證碼；登入失效時會標記為需要重新驗證。",
    cathaybk:
      "首次驗證會加入信任裝置；信任失效時需在手動同步中重新取得驗證碼。",
    ctbc: "中信 App 核准只適用於當次登入，目前尚未支援網銀的信任瀏覽器功能。需要兩階段驗證時請在此完成；銀行仍可能要求再次核准或換密碼。",
  };

  let {
    api,
    connectorId,
    demoMode,
    title,
    embedded = false,
  }: {
    api: ApiClient;
    connectorId: ConnectorId;
    demoMode: boolean;
    title: string;
    embedded?: boolean;
  } = $props();
  const fields = $derived(connectorCatalog[connectorId].credentialFields);
  const qc = useQueryClient();
  const settings = createQuery(() =>
    connectorSettingsQuery(() => api, connectorId),
  );
  const jobs = createQuery(() => syncJobsQuery(() => api));
  const defaultSchedule = createQuery(() => syncScheduleQuery(() => api));
  let values = $state<Record<string, string>>({});
  let focusedCredentialKeys = $state<Record<string, boolean>>({});
  let error = $state("");
  let otp = $state("");
  let ctbcVerificationBusy = $state(false);
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
  // 兆豐異地簡訊 3 分鐘；台北富邦雙重驗證 OTP 官方 300 秒，伺服器保留約 4.5 分鐘。
  const otpWindowMs = $derived(
    connectorId === "fubon" ? 4.5 * 60_000 : 3 * 60_000,
  );
  const otpBankName = $derived(connectorId === "fubon" ? "台北富邦" : "兆豐");
  let pendingSyncTarget = $state<SyncTarget>("default");
  // 電子發票與集保以 Queue 分段同步；一個面板只對應一個來源，共用同一組追蹤狀態。
  const durableRunSource = $derived(
    connectorId === "einvoice" || connectorId === "tdcc",
  );
  let durableSyncQueued = $state(false);
  let durableSyncQueuedTimer: ReturnType<typeof setTimeout> | undefined;
  let durableSyncPolling = $state<"awaiting-active" | "active" | null>(null);
  let durableSyncPreviousLastRunAt = $state<string | null>(null);
  let durableSyncPollingTimer: ReturnType<typeof setTimeout> | undefined;
  let interruptedSync = $state<"polling" | "timeout" | null>(null);
  let interruptedSyncPreviousLastRunAt: string | null = null;
  let interruptedSyncDeadline = 0;
  let interruptedSyncTimer: ReturnType<typeof setTimeout> | undefined;
  // 本次在畫面上按下的背景手動同步；結束後沿用同步請求的錯誤處理接續驗證流程。
  let trackedManualRunId = $state<string | null>(null);
  let cathaySessionRetried = false;
  let syncStartLastRunAt: string | null = null;
  let syncStartJobKnown = false;
  let destroyed = false;
  const job = $derived(
    (jobs.data ?? []).find(
      (j) => j.connectorId === connectorId && j.scope === "all",
    ),
  );
  const syncBusy = $derived(Boolean(job?.running && job.phase !== "stalled"));
  const SYNC_PHASE_LABELS: Record<string, string> = {
    queued: "排隊中",
    login: "正在登入",
    initializing: "正在登入",
    fetching: "正在取得資料",
    bank: "正在查詢銀行資料",
    trades: "正在查詢投資交易",
    saving: "正在儲存結果",
    promoting: "正在儲存結果",
    promote: "正在儲存結果",
  };
  const syncStatusLabel = $derived.by(() => {
    if (!job) return null;
    if (job.phase === "stalled") return "同步停滯，可重試";
    if (job.running) return SYNC_PHASE_LABELS[job.phase ?? ""] ?? "同步中";
    if (job.lastStatus === "success") return "正常";
    if (job.lastStatus === "failed") return "失敗";
    if (job.lastStatus === "needs_user_action") return "需要處理";
    return "尚未同步";
  });
  const syncBusyLabel = $derived(
    !syncBusy
      ? null
      : job?.lockTrigger === "scheduled"
        ? "排程同步中…"
        : job?.phase === "queued"
          ? "排隊中…"
          : "同步中…",
  );
  $effect(() => {
    const run = job?.manualRun;
    if (!trackedManualRunId || !run || run.id !== trackedManualRunId) return;
    if (run.status === "queued" || run.status === "running") return;
    untrack(() => {
      trackedManualRunId = null;
      if (run.status === "completed") {
        finishManualSync();
        return;
      }
      const failure = syncJobFailure({
        lastErrorCode: run.errorCode,
        lastError: run.lastError,
      });
      if (
        connectorId === "cathaybk" &&
        failure.code === "CATHAY_OTP_SESSION_EXPIRED" &&
        !cathaySessionRetried
      ) {
        cathaySessionRetried = true;
        sync.mutate("default");
        return;
      }
      handleSyncFailure(failure);
    });
  });
  const pendingUserAction = $derived.by(() => {
    if (
      !job ||
      job.running ||
      trackedManualRunId ||
      job.lastStatus !== "needs_user_action"
    )
      return null;
    const code = job.lastErrorCode;
    if (
      captchaBank &&
      connectorId !== "nextbank" &&
      code === "MANUAL_CAPTCHA_REQUIRED" &&
      !bankCaptchaImage &&
      !prepareCaptchaBank.isPending
    )
      return code;
    if (
      (code === "MEGABANK_SMS_OTP_REQUIRED" || code === "FUBON_OTP_REQUIRED") &&
      !megabankOtpStep &&
      Date.parse(job.lastRunAt ?? "") + otpWindowMs > Date.now()
    )
      return code;
    if (
      connectorId === "tdcc" &&
      (code === "TDCC_EMAIL_OTP_REQUIRED" ||
        code === "TDCC_SMS_OTP_REQUIRED") &&
      tdccSetupStep !== "email" &&
      tdccSetupStep !== "sms"
    )
      return code;
    return null;
  });
  $effect(() => {
    if (!job?.running || destroyed) return;
    if (durableRunSource && durableSyncPolling === null)
      startDurableSyncPolling();
  });
  // 需要使用者輸入驗證碼的來源，包含走 App API 的王道、將來與兆豐；依 catalog 的連接模式判斷。
  const captchaBank = $derived(
    connectorCatalog[connectorId].connectionMode ===
      "browser_captcha_session" ||
      connectorCatalog[connectorId].connectionMode === "api_captcha_session",
  );
  const captchaBankSessionAvailable = $derived(
    captchaBank && Boolean(settings.data?.sessionAvailable),
  );
  const syncsCreditCardBills = $derived(
    (
      connectorCatalog[connectorId]
        .capabilities as readonly ConnectorCapability[]
    ).includes("credit_card_bill"),
  );
  const megabankOtpActive = $derived(
    (connectorId === "megabank" || connectorId === "fubon") && megabankOtpStep,
  );
  const otpPattern = $derived(
    connectorId === "fubon" ? /^\d{6}$/ : /^\d{4,8}$/,
  );
  const tdccConnectionReady = $derived(
    connectorId === "tdcc" && Boolean(settings.data?.sessionAvailable),
  );
  const tdccCredentialsComplete = $derived(
    connectorId === "tdcc" && Boolean(settings.data?.credentialsComplete),
  );
  const cathayConnectionReady = $derived(
    connectorId === "cathaybk" && Boolean(settings.data?.sessionAvailable),
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

  $effect(() => {
    const data = settings.data;
    untrack(() => {
      for (const [key, value] of Object.entries(data?.publicConfig ?? {})) {
        if (values[key] === undefined) values[key] = String(value);
      }
      if (connectorId === "cathaybk" && data) {
        if (data.sessionAvailable) {
          cathayVerificationStep = "complete";
          cathayVerificationExpiresAt = null;
          cathayVerificationSecondsRemaining = null;
        } else if (data.verificationPending) {
          const channel = data.verificationChannel;
          cathayOtpChannel =
            channel === "email" || channel === "sms" ? channel : null;
          cathayVerificationStep = cathayOtpChannel ?? "choose";
          cathayVerificationExpiresAt = data.verificationExpiresAt ?? null;
          updateCathayVerificationCountdown();
        } else if (data.verificationExpiresAt) {
          cathayOtpChannel = null;
          cathayVerificationStep = "choose";
          cathayVerificationExpiresAt = data.verificationExpiresAt;
          updateCathayVerificationCountdown();
        } else if (cathayVerificationStep === "complete") {
          cathayVerificationStep = "idle";
        }
      }
    });
  });
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
    clearTimeout(durableSyncQueuedTimer);
    stopDurableSyncPolling();
  });

  const save = createMutation(() => ({
    mutationFn: (config: Record<string, unknown>) => {
      if (!Object.keys(config).length) throw new Error("請先填寫欄位再儲存。");
      return api.put(`/api/connectors/${connectorId}/settings`, { config });
    },
    onSuccess: () => {
      error = "";
      if (connectorId === "cathaybk") resetCathayVerification();
      for (const field of fields) values[field.key] = "";
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    },
    onError: (e) => (error = e instanceof Error ? e.message : "儲存失敗"),
  }));
  const updateJob = createMutation(() => ({
    mutationFn: (payload: Record<string, unknown>) =>
      api.patch(`/api/sync-jobs/${connectorId}/all`, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.syncJobs }),
  }));
  const sync = createMutation(() => ({
    mutationFn: (target: SyncTarget) => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      if (captchaBank) {
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
      return api.post<QueuedSyncResponse>(
        path,
        connectorId === "einvoice" ||
          connectorId === "tdcc" ||
          connectorId === "ctbc"
          ? {}
          : undefined,
      );
    },
    onSuccess: (data) => {
      error = "";
      if (durableRunSource) {
        showDurableSyncQueued();
        startDurableSyncPolling();
        return;
      }
      if (data?.status === "queued") trackedManualRunId = data.runId;
      else finishManualSync();
    },
    onError: (e) => {
      if (isRequestInterrupted(e)) {
        startInterruptedSyncPolling();
        return;
      }
      if (e instanceof ApiRequestError && e.code === "SYNC_ALREADY_RUNNING") {
        error = "此來源正在同步，完成後即可查看結果。";
        return;
      }
      handleSyncFailure(e);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.syncJobs }),
  }));
  /** 背景手動同步完成；與原本同步請求成功後的畫面更新相同。 */
  function finishManualSync() {
    error = "";
    cathaySessionRetried = false;
    if (connectorId === "ctbc")
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
    if (connectorId === "nextbank") bankOperation = "success";
    if (connectorId === "cathaybk") {
      resetCathayVerification();
      cathayVerificationStep = "complete";
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
    }
    refreshAfterManualSync();
  }
  /** 同步失敗或需要使用者操作；背景 run 的錯誤代碼也走這裡接續驗證流程。 */
  function handleSyncFailure(e: unknown, megabankOtpExpiresAt?: number) {
    if (handleTdccVerificationRequired(e)) return;
    if (handleCathayVerificationRequired(e)) return;
    if (connectorId === "ctbc") {
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      if (
        e instanceof ApiRequestError &&
        (e.code === "CTBC_APP_APPROVAL_REQUIRED" ||
          e.code === "CTBC_EMAIL_OTP_REQUIRED")
      ) {
        error = "";
        return;
      }
    }
    if (isBankOtpRequired(connectorId, e)) {
      enterMegabankOtp(
        e instanceof Error && e.message
          ? e.message
          : `${otpBankName}銀行已寄出驗證碼，請於時限內輸入。`,
        megabankOtpExpiresAt,
      );
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      return;
    }
    error = e instanceof Error ? e.message : "同步失敗";
    if (captchaBank && isManualCaptchaRequired(e)) {
      // 自動辨識失敗：直接取得人工驗證碼，不再重試自動登入
      prepareCaptchaBank.mutate();
    } else if (needsNextbankCaptcha(connectorId, e)) {
      prepareCaptchaBank.mutate();
    }
    if (captchaBank)
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
  }
  /** 背景同步只留下錯誤代碼與訊息；轉成同步請求的錯誤，沿用相同的驗證接續。 */
  function syncJobFailure(
    syncJob: Pick<SyncJobRow, "lastErrorCode" | "lastError">,
    fallback = "同步失敗",
  ) {
    return new ApiRequestError(
      syncJob.lastErrorCode ?? "SYNC_FAILED",
      syncJob.lastError?.trim() || fallback,
      0,
    );
  }
  /** 回到頁面後接續背景同步留下的驗證需求。 */
  function resumePendingUserAction() {
    if (!job?.lastErrorCode) return;
    error = "";
    const failure = syncJobFailure(job);
    if (
      job.lastErrorCode === "MEGABANK_SMS_OTP_REQUIRED" ||
      job.lastErrorCode === "FUBON_OTP_REQUIRED"
    ) {
      const expiresAt = Date.parse(job.lastRunAt ?? "") + otpWindowMs;
      if (!(expiresAt > Date.now())) {
        error = `${otpBankName}驗證碼已逾時，請重新同步取得新的驗證碼。`;
        return;
      }
      handleSyncFailure(failure, expiresAt);
      return;
    }
    handleSyncFailure(failure);
  }
  const connectTdcc = createMutation(() => ({
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
    onSuccess: () => finishTdccConnection(false),
    onError: (e) => {
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      if (handleTdccVerificationRequired(e)) return;
      error = e instanceof Error ? e.message : "集保連線失敗";
    },
  }));
  const prepareCaptchaBank = createMutation(() => ({
    mutationFn: () => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      if (!captchaBank) throw new Error("此資料來源不支援圖形驗證。");
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
  }));
  const verifyCaptchaBank = createMutation(() => ({
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
    onSuccess: () => {
      error = "";
      bankCaptcha = "";
      bankCaptchaImage = "";
      if (connectorId === "nextbank") bankOperation = "success";
      refreshAfterVerification();
    },
    onError: (e) => {
      if (needsNextbankCaptcha(connectorId, e)) {
        prepareCaptchaBank.mutate();
        qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
        return;
      }
      if (isBankOtpRequired(connectorId, e)) {
        enterMegabankOtp(
          e instanceof Error
            ? e.message
            : `${otpBankName}銀行已寄出驗證碼，請於時限內輸入。`,
        );
        qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
        return;
      }
      const failure = captchaBankFailure(e);
      error = failure.message;
      if (failure.sessionInvalidated || bankVerificationSubmitted) {
        bankCaptcha = "";
        bankCaptchaImage = "";
        qc.invalidateQueries({
          queryKey: queryKeys.connectorSettings(connectorId),
        });
      }
    },
  }));
  const verifyMegabankOtp = createMutation(() => ({
    mutationFn: () => {
      if (demoMode) throw new Error("Demo site 已停用連接器同步。");
      const trimmed = megabankOtp.trim();
      if (!otpPattern.test(trimmed))
        throw new Error(
          connectorId === "fubon"
            ? "請輸入簡訊或 Email 收到的 6 位數字驗證碼。"
            : "請輸入簡訊收到的 4-8 位數字驗證碼。",
        );
      return api.post(`/api/connectors/${connectorId}/sync`, { otp: trimmed });
    },
    onSuccess: () => {
      error = "";
      resetMegabankOtp();
      bankCaptcha = "";
      bankCaptchaImage = "";
      refreshAfterVerification();
    },
    onError: (e) => {
      if (megabankOtpFailure(e) === "retry") {
        megabankOtp = "";
        error =
          e instanceof Error
            ? e.message
            : `${otpBankName}銀行驗證碼不正確，請重新輸入。`;
        return;
      }
      const failure = captchaBankFailure(e);
      resetMegabankOtp();
      error = failure.message;
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
    },
  }));
  const verifyOtp = createMutation(() => ({
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
    onSuccess: () => finishTdccConnection(true),
    onError: (e) => {
      if (handleTdccVerificationRequired(e)) {
        otp = "";
        return;
      }
      error = e instanceof Error ? e.message : "驗證失敗";
    },
  }));

  const requestCathayOtp = createMutation(() => ({
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
  }));

  const verifyCathayOtp = createMutation(() => ({
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
  }));

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
    requestCathayOtp.reset();
    verifyCathayOtp.reset();
  }

  function finishCathayVerification() {
    error = "";
    resetCathayVerification();
    cathayVerificationStep = "complete";
    refreshAfterVerification();
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

  function countdownLabel(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function restartCathayVerification() {
    resetCathayVerification();
    error = "";
    sync.mutate("default");
  }

  function enterMegabankOtp(
    message: string,
    expiresAt = Date.now() + otpWindowMs,
  ) {
    error = "";
    bankCaptcha = "";
    bankCaptchaImage = "";
    megabankOtp = "";
    megabankOtpMessage = message;
    megabankOtpStep = true;
    megabankOtpExpiresAt = expiresAt;
    megabankOtpSecondsRemaining = Math.max(
      0,
      Math.ceil((expiresAt - Date.now()) / 1_000),
    );
  }

  function resetMegabankOtp() {
    megabankOtpStep = false;
    megabankOtp = "";
    megabankOtpMessage = "";
    megabankOtpExpiresAt = null;
    megabankOtpSecondsRemaining = 0;
    verifyMegabankOtp.reset();
  }

  function updateMegabankOtpCountdown() {
    if (!megabankOtpStep || megabankOtpExpiresAt === null) return;
    megabankOtpSecondsRemaining = Math.max(
      0,
      Math.ceil((megabankOtpExpiresAt - Date.now()) / 1_000),
    );
    if (megabankOtpSecondsRemaining <= 0) {
      error = `${otpBankName}驗證碼已逾時，請重新同步。`;
      resetMegabankOtp();
    }
  }

  /** `loginVerified` 為 false 時登入仍在背景進行，等輪詢結果再決定是否進入驗證步驟。 */
  function finishTdccConnection(loginVerified: boolean) {
    error = "";
    otp = "";
    if (loginVerified) tdccSetupStep = "complete";
    sync.reset();
    for (const field of fields) values[field.key] = "";
    qc.invalidateQueries({
      queryKey: queryKeys.connectorSettings(connectorId),
    });
    qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    qc.invalidateQueries({ queryKey: queryKeys.summary });
    invalidateLatestSyncReport();
    qc.invalidateQueries({ queryKey: queryKeys.investments });
    qc.invalidateQueries({ queryKey: queryKeys.investmentTransactions });
    qc.invalidateQueries({ queryKey: queryKeys.bank });
    showDurableSyncQueued();
    startDurableSyncPolling();
  }

  function buildConfig() {
    const entries: Array<[string, string]> = [];
    for (const field of fields) {
      const raw = values[field.key];
      if (raw === undefined || raw === "") continue;
      entries.push([field.key, raw]);
    }
    return Object.fromEntries(entries);
  }
  function showDurableSyncQueued() {
    durableSyncQueued = true;
    clearTimeout(durableSyncQueuedTimer);
    durableSyncQueuedTimer = setTimeout(() => {
      durableSyncQueued = false;
    }, 5_000);
  }
  function refreshAfterManualSync() {
    invalidateLatestSyncReport();
    qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    qc.invalidateQueries({ queryKey: queryKeys.summary });
    qc.invalidateQueries({ queryKey: queryKeys.exchangeRates });
    if (
      connectorId === "esun" ||
      connectorId === "cathaybk" ||
      connectorId === "ctbc"
    ) {
      qc.invalidateQueries({ queryKey: queryKeys.bank });
    } else if (captchaBank) {
      qc.invalidateQueries({
        queryKey: queryKeys.connectorSettings(connectorId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.bank });
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
    // 依 connector catalog 判斷，有信用卡帳單的來源同步後一律重抓帳單。
    if (syncsCreditCardBills)
      qc.invalidateQueries({ queryKey: queryKeys.bills });
  }
  function startInterruptedSyncPolling() {
    error = "";
    if (!syncStartJobKnown) {
      // 沒有送出前的基準，無法分辨背景結果是否屬於這次同步，不猜測。
      interruptedSync = "timeout";
      qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
      return;
    }
    interruptedSync = "polling";
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
      if (current.lastStatus === "success") finishManualSync();
      else handleSyncFailure(syncJobFailure(current));
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
  function startDurableSyncPolling() {
    durableSyncPolling = "awaiting-active";
    durableSyncPreviousLastRunAt = job?.lastRunAt ?? null;
    clearTimeout(durableSyncPollingTimer);
    void pollDurableSyncJob();
  }
  function stopDurableSyncPolling() {
    durableSyncPolling = null;
    clearTimeout(durableSyncPollingTimer);
    durableSyncPollingTimer = undefined;
  }
  async function pollDurableSyncJob() {
    const syncJobs = await qc
      .fetchQuery({ ...syncJobsQuery(() => api), staleTime: 0 })
      .catch(() => undefined);
    if (!durableSyncPolling || destroyed) return;
    const runJob = syncJobs?.find(
      (syncJob) =>
        syncJob.connectorId === connectorId && syncJob.scope === "all",
    );
    if (runJob?.running) {
      durableSyncPolling = "active";
    } else if (
      runJob &&
      (durableSyncPolling === "active" ||
        runJob.lastRunAt !== durableSyncPreviousLastRunAt)
    ) {
      const status = runJob.lastStatus;
      stopDurableSyncPolling();
      if (status === "success") {
        invalidateLatestSyncReport();
        qc.invalidateQueries({ queryKey: queryKeys.summary });
      }
      if (connectorId === "einvoice") {
        if (status === "success")
          qc.invalidateQueries({ queryKey: queryKeys.invoices });
      } else if (status === "success") {
        tdccSetupStep = "complete";
        qc.invalidateQueries({ queryKey: queryKeys.connectorSettings("tdcc") });
        qc.invalidateQueries({ queryKey: queryKeys.investments });
        qc.invalidateQueries({ queryKey: queryKeys.investmentTransactions });
        qc.invalidateQueries({ queryKey: queryKeys.bank });
      } else if (status === "failed" || status === "needs_user_action") {
        const failure = syncJobFailure(runJob, "集保同步失敗，請重新驗證。");
        if (!handleTdccVerificationRequired(failure)) error = failure.message;
      }
      return;
    }
    durableSyncPollingTimer = setTimeout(() => {
      void pollDurableSyncJob();
    }, 2_000);
  }
  /** 驗證碼或 OTP 驗證後接續同步完成。 */
  function refreshAfterVerification() {
    qc.invalidateQueries({
      queryKey: queryKeys.connectorSettings(connectorId),
    });
    qc.invalidateQueries({ queryKey: queryKeys.syncJobs });
    qc.invalidateQueries({ queryKey: queryKeys.summary });
    invalidateLatestSyncReport();
    qc.invalidateQueries({ queryKey: queryKeys.bank });
    qc.invalidateQueries({ queryKey: queryKeys.bills });
  }
  function invalidateLatestSyncReport() {
    qc.invalidateQueries({ queryKey: queryKeys.latestSyncReport });
  }
</script>

{#snippet verificationHeader(
  channel: "email" | "sms",
  title: string,
  description: string,
  secondsRemaining: number | null,
)}
  <div class="flex items-start gap-3 border-b border-steel/15 px-4 py-3">
    <span
      class="grid size-9 shrink-0 place-items-center rounded-full bg-steel/10 text-steel"
    >
      {#if channel === "sms"}<Smartphone class="size-4.5" />{:else}<Mail
          class="size-4.5"
        />{/if}
    </span>
    <div>
      <p class="text-sm font-semibold text-ink">{title}</p>
      <p class="mt-0.5 text-sm leading-relaxed text-ink/60">{description}</p>
      {#if secondsRemaining !== null}
        <p class="mt-1 text-xs font-semibold text-steel" aria-live="polite">
          請於 {countdownLabel(secondsRemaining)} 內完成驗證
        </p>
      {/if}
    </div>
  </div>
{/snippet}

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
              settings.data?.configured &&
              !tdccCredentialsComplete
            ? "舊設定缺少完整的登入資料，請重新輸入身分證字號與 App 密碼。"
            : settings.data?.configured
              ? `已設定於 ${formatDateTime(settings.data.updatedAt)}。機密資料不會在此顯示；重新填寫欄位即可覆寫。`
              : "尚未設定"}
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      {#if connectorId === "tdcc" && tdccConnectionReady}
        <Button
          size="sm"
          disabled={demoMode ||
            syncBusy ||
            sync.isPending ||
            verifyOtp.isPending ||
            durableSyncPolling !== null}
          onclick={() => sync.mutate("default")}
          ><RefreshCw
            class={sync.isPending ? "size-4 animate-spin" : "size-4"}
          />{sync.isPending
            ? "同步中…"
            : durableSyncQueued
              ? "已排入同步"
              : (syncBusyLabel ??
                (durableSyncPolling ? "同步中…" : "同步"))}</Button
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
      {:else if captchaBank}
        {#if captchaBankSessionAvailable}
          <Button
            size="sm"
            disabled={demoMode ||
              syncBusy ||
              sync.isPending ||
              verifyCaptchaBank.isPending ||
              megabankOtpActive}
            onclick={() => {
              error = "";
              sync.mutate("default");
            }}
            ><RefreshCw class="size-4" />{sync.isPending
              ? "同步中…"
              : (syncBusyLabel ?? "同步")}</Button
          >
          <Button
            size="sm"
            variant="outline"
            disabled={demoMode ||
              syncBusy ||
              prepareCaptchaBank.isPending ||
              verifyCaptchaBank.isPending ||
              megabankOtpActive}
            onclick={() => {
              error = "";
              prepareCaptchaBank.mutate();
            }}
            ><KeyRound class="size-4" />{prepareCaptchaBank.isPending
              ? "取得中…"
              : "人工重新驗證"}</Button
          >
        {:else}
          <Button
            size="sm"
            disabled={demoMode ||
              syncBusy ||
              sync.isPending ||
              prepareCaptchaBank.isPending ||
              verifyCaptchaBank.isPending ||
              megabankOtpActive}
            onclick={() => {
              error = "";
              sync.mutate("default");
            }}
            ><RefreshCw
              class={sync.isPending ? "size-4 animate-spin" : "size-4"}
            />{sync.isPending
              ? "送出中…"
              : (syncBusyLabel ?? "自動驗證並同步")}</Button
          >
          <Button
            size="sm"
            variant="outline"
            disabled={demoMode ||
              syncBusy ||
              sync.isPending ||
              prepareCaptchaBank.isPending ||
              verifyCaptchaBank.isPending ||
              megabankOtpActive}
            onclick={() => {
              error = "";
              prepareCaptchaBank.mutate();
            }}
            ><KeyRound class="size-4" />{prepareCaptchaBank.isPending
              ? "取得中…"
              : "人工輸入驗證碼"}</Button
          >
        {/if}
      {:else}
        <Button
          size="sm"
          disabled={demoMode ||
            syncBusy ||
            sync.isPending ||
            (connectorId === "ctbc" &&
              (ctbcVerificationBusy ||
                Boolean(settings.data?.verificationExpiresAt))) ||
            (connectorId === "einvoice" && durableSyncPolling !== null) ||
            (connectorId === "cathaybk" &&
              !cathayVerificationExpired &&
              (cathayVerificationStep === "choose" ||
                cathayVerificationStep === "email" ||
                cathayVerificationStep === "sms"))}
          onclick={() => {
            error = "";
            interruptedSync = null;
            stopInterruptedSyncPolling();
            sync.mutate("default");
          }}
          ><RefreshCw
            class={sync.isPending ? "size-4 animate-spin" : "size-4"}
          />{sync.isPending
            ? "同步中…"
            : connectorId === "einvoice" && durableSyncQueued
              ? "已排入同步"
              : (syncBusyLabel ??
                (connectorId === "einvoice" && durableSyncPolling
                  ? "同步中…"
                  : "同步"))}</Button
        >
      {/if}
    </div>
  </div>
  {#if demoMode}<p
      class="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      Demo site 已停用同步；你仍可查看示範資料與介面互動。
    </p>{/if}
  {#if connectorId === "ctbc"}
    {#key settings.data?.updatedAt}
      <CtbcVerification
        {api}
        pending={settings.data?.verificationPending}
        channel={settings.data?.verificationChannel}
        expiresAt={settings.data?.verificationExpiresAt}
        disabled={demoMode || syncBusy || sync.isPending || save.isPending}
        bind:busy={ctbcVerificationBusy}
        onSuccess={() => {
          error = "";
          refreshAfterManualSync();
        }}
      />
    {/key}
  {/if}
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
  {:else if captchaBank}
    {#if connectorId === "nextbank"}
      <section
        aria-label="同步進度"
        aria-live="polite"
        class="mt-3 rounded-xl border border-border bg-muted/40 p-4"
      >
        {#if !settings.data?.credentialsComplete}
          <p class="font-semibold">先儲存帳密</p>
          <p class="mt-1 text-sm text-muted-foreground">
            請填寫下方連線憑證並儲存，再按「同步帳戶」。
          </p>
        {:else if prepareCaptchaBank.isPending}
          <p role="status" class="font-semibold">正在取得驗證碼圖片…</p>
          <p class="mt-1 text-sm">
            取得後會在下方顯示圖片與輸入欄，請勿重複點擊。
          </p>
        {:else if sync.isPending || verifyCaptchaBank.isPending || syncBusy}
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
                !settings.data?.credentialsComplete ||
                syncBusy ||
                save.isPending ||
                sync.isPending ||
                prepareCaptchaBank.isPending ||
                verifyCaptchaBank.isPending}
              onclick={() => {
                error = "";
                sync.mutate("default");
              }}
            >
              <RefreshCw
                class={sync.isPending || verifyCaptchaBank.isPending
                  ? "size-4 animate-spin"
                  : "size-4"}
              />
              {sync.isPending || verifyCaptchaBank.isPending
                ? "同步中…"
                : (syncBusyLabel ?? "同步帳戶")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={demoMode ||
                !settings.data?.credentialsComplete ||
                syncBusy ||
                save.isPending ||
                sync.isPending ||
                prepareCaptchaBank.isPending ||
                verifyCaptchaBank.isPending}
              onclick={() => prepareCaptchaBank.mutate()}
            >
              <KeyRound class="size-4" />{prepareCaptchaBank.isPending
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
    <CaptchaBankConnectionHelp
      {connectorId}
      bind:captcha={bankCaptcha}
      captchaImage={bankCaptchaImage}
      digitCount={bankCaptchaDigitCount}
      captchaKind={bankCaptchaKind}
      preparing={prepareCaptchaBank.isPending}
      verifying={verifyCaptchaBank.isPending}
      syncing={sync.isPending}
      expiresIn={connectorId === "nextbank" ? bankCaptchaSeconds : undefined}
      onVerify={() => {
        error = "";
        verifyCaptchaBank.mutate();
      }}
      onRefresh={() => prepareCaptchaBank.mutate()}
    />
  {/if}
  {#if pendingUserAction}
    <div
      role="status"
      class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-coral/30 bg-coral/[0.06] p-3 text-sm"
    >
      <p>
        <span class="font-semibold">背景同步需要你處理：</span
        >{job?.lastError ?? "請完成驗證後繼續同步。"}
      </p>
      <Button
        size="sm"
        disabled={demoMode ||
          prepareCaptchaBank.isPending ||
          verifyCaptchaBank.isPending}
        onclick={resumePendingUserAction}>處理</Button
      >
    </div>
  {/if}
  <div
    class={`mt-3 rounded-xl border border-ink/10 bg-paper p-3 text-sm ${(connectorId === "tdcc" && !tdccConnectionReady && !job?.running) || (connectorId === "cathaybk" && !cathayConnectionReady && cathayVerificationStep !== "complete") ? "hidden" : ""}`}
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        {#if syncStatusLabel && connectorId !== "nextbank"}
          <p class="flex flex-wrap items-center gap-x-2 text-ink/70">
            <span class="font-semibold text-ink">狀態：{syncStatusLabel}</span>
            {#if captchaBank}<span aria-hidden="true">·</span><span
                >{captchaBankSessionAvailable
                  ? "已保存登入"
                  : "下次同步自動登入"}</span
              >{/if}
          </p>
        {/if}
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
          disabled={demoMode || updateJob.isPending}
          onclick={() => updateJob.mutate({ enabled: !job.enabled })}
          >{job.enabled ? "關閉自動同步" : "開啟自動同步"}</Button
        >{/if}
    </div>
    {#if job?.phase === "stalled" && durableRunSource}
      <Button
        size="sm"
        variant="outline"
        disabled={demoMode || sync.isPending}
        onclick={() =>
          sync.mutate(
            connectorId === "tdcc" &&
              (job.lockScope === "bank" ||
                job.lockScope === "investments" ||
                job.lockScope === "trades")
              ? job.lockScope
              : "default",
          )}>重試同步</Button
      >
    {/if}

    {#if job && !job.lastSuccessAt}
      <p class="mt-2 text-sm text-muted-foreground">
        首次同步成功後會自動開啟排程；若之後手動關閉，後續同步會保留此設定。
      </p>
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
            disabled={demoMode || updateJob.isPending}
            onchange={(event: Event) =>
              updateJob.mutate({
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
            {#if defaultSchedule.data}
              {#if defaultSchedule.data.intervalMinutes === 10080}
                {formatScheduleWeekdays(defaultSchedule.data.preferredWeekdays)}
                {defaultSchedule.data.preferredTime} 起
              {:else}
                {syncIntervalLabel(
                  defaultSchedule.data.intervalMinutes,
                )}{#if defaultSchedule.data.intervalMinutes >= 1440}
                  {defaultSchedule.data.preferredTime} 起{/if}
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
              disabled={demoMode || updateJob.isPending}
              onchange={(event: Event) =>
                updateJob.mutate({
                  intervalMinutes: Number(
                    (event.currentTarget as HTMLSelectElement).value,
                  ),
                })}
            >
              {#each syncIntervalOptions as option (option.minutes)}
                <option value={option.minutes}>{option.label}</option>
              {/each}
            </Select>
          </label>
          {#if job.intervalMinutes === 10080}
            <WeekdayPicker
              class="md:col-span-4"
              value={job.preferredWeekdays}
              disabled={demoMode || updateJob.isPending}
              onchange={(preferredWeekdays) =>
                updateJob.mutate({ preferredWeekdays })}
            />
          {/if}
          {#if job.intervalMinutes >= 1440}
            <label class="grid gap-1 text-sm font-semibold text-ink/70">
              開始時間
              <TimePicker
                value={job.preferredTime}
                onchange={(preferredTime) =>
                  !demoMode && updateJob.mutate({ preferredTime })}
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
      {#if save.isSuccess}<span
          class="rounded-full bg-moss/10 px-2.5 py-1 text-sm font-semibold text-moss"
          >已安全儲存</span
        >{/if}
    </div>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="grid gap-3 p-4">
        {#each fields as field (field.key)}
          {@const storedCredential = Boolean(
            settings.data?.configured &&
            (connectorId !== "tdcc" || tdccCredentialsComplete),
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
                : undefined}
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
            disabled={connectTdcc.isPending ||
              verifyOtp.isPending ||
              syncBusy ||
              durableSyncPolling !== null ||
              demoMode}
            onclick={() => {
              error = "";
              tdccSetupStep = "credentials";
              connectTdcc.mutate();
            }}
            ><ShieldCheck class="size-4" />{connectTdcc.isPending ||
            (durableSyncPolling !== null && !tdccConnectionReady)
              ? "正在連線…"
              : tdccConnectionReady
                ? "更新並重新連線"
                : "連線並取得驗證碼"}</Button
          >
        {:else}
          <Button
            size="sm"
            disabled={save.isPending}
            onclick={() => {
              error = "";
              save.reset();
              save.mutate(buildConfig());
            }}
            ><Save class="size-4" />{save.isPending
              ? "儲存中…"
              : "儲存憑證"}</Button
          >
        {/if}
      </div>
    </form>
  </section>
  {#if save.isError}<p class="mt-2 text-sm font-medium text-coral">
      儲存失敗：{error}
    </p>{/if}
  {#if connectorId === "tdcc" && (tdccSetupStep === "email" || tdccSetupStep === "sms")}<div
      class="mt-3 overflow-hidden rounded-xl border border-steel/20 bg-steel/[0.055]"
    >
      {@render verificationHeader(
        tdccSetupStep === "sms" ? "sms" : "email",
        tdccSetupStep === "sms" ? "簡訊驗證碼已寄出" : "Email 驗證碼已寄出",
        tdccSetupStep === "sms"
          ? "Email 驗證已通過；請輸入集保寄到手機的驗證碼。"
          : "請查看集保帳號登記的電子信箱，也別忘了檢查垃圾郵件匣。",
        null,
      )}
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
          disabled={verifyOtp.isPending || !otp.trim()}
          onclick={() => {
            error = "";
            verifyOtp.mutate();
          }}
          ><ShieldCheck class="size-4" />{verifyOtp.isPending
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
            disabled={sync.isPending}
            onclick={() => {
              error = "";
              sync.mutate("default");
            }}
            ><RefreshCw class="size-4" />{sync.isPending
              ? "重新寄送中…"
              : "重新寄送 Email"}</Button
          >{/if}
      </div>
    </div>{/if}
  {#if connectorId === "cathaybk" && (cathayVerificationStep === "choose" || cathayVerificationStep === "email" || cathayVerificationStep === "sms")}
    <div
      class="mt-3 overflow-hidden rounded-xl border border-steel/20 bg-steel/[0.055]"
    >
      {@render verificationHeader(
        cathayVerificationStep === "sms" ? "sms" : "email",
        cathayVerificationExpired
          ? "驗證工作階段已逾時"
          : cathayVerificationStep === "choose"
            ? "需要額外驗證"
            : cathayVerificationStep === "sms"
              ? "簡訊驗證碼已寄出"
              : "Email 驗證碼已寄出",
        cathayVerificationExpired
          ? "為避免持續占用 Browser Run，驗證工作階段已關閉，請重新同步。"
          : cathayVerificationStep === "choose"
            ? "國泰世華要求額外驗證，請選擇驗證碼寄送方式。"
            : cathayVerificationStep === "sms"
              ? "請輸入國泰世華寄到手機的驗證碼。"
              : "請查看國泰世華帳號登記的電子信箱，也別忘了檢查垃圾郵件匣。",
        cathayVerificationExpired ? null : cathayVerificationSecondsRemaining,
      )}
      {#if cathayVerificationExpired}
        <div class="p-4">
          <Button
            size="sm"
            disabled={sync.isPending}
            onclick={restartCathayVerification}
            ><RefreshCw
              class={sync.isPending ? "size-4 animate-spin" : "size-4"}
            />{sync.isPending ? "重新連線中…" : "重新開始驗證"}</Button
          >
        </div>
      {:else if cathayVerificationStep === "choose"}
        <div class="flex flex-wrap gap-2 p-4">
          <Button
            size="sm"
            disabled={requestCathayOtp.isPending || verifyCathayOtp.isPending}
            onclick={() => {
              error = "";
              requestCathayOtp.mutate("email");
            }}
            ><Mail class="size-4" />{requestCathayOtp.isPending &&
            cathayOtpChannel === "email"
              ? "寄送中…"
              : "使用 Email"}</Button
          >
          <Button
            size="sm"
            variant="outline"
            disabled={requestCathayOtp.isPending || verifyCathayOtp.isPending}
            onclick={() => {
              error = "";
              requestCathayOtp.mutate("sms");
            }}
            ><Smartphone class="size-4" />{requestCathayOtp.isPending &&
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
            disabled={verifyCathayOtp.isPending || !otp.trim()}
            onclick={() => {
              error = "";
              verifyCathayOtp.mutate();
            }}
            ><ShieldCheck class="size-4" />{verifyCathayOtp.isPending
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
              requestCathayOtp.reset();
            }}>返回選擇驗證方式</button
          >
          <Button
            size="sm"
            variant="outline"
            disabled={requestCathayOtp.isPending || !cathayOtpChannel}
            onclick={() => {
              error = "";
              requestCathayOtp.mutate(cathayOtpChannel!);
            }}
            ><RefreshCw class="size-4" />{requestCathayOtp.isPending
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
      {@render verificationHeader(
        "sms",
        connectorId === "fubon" ? "雙重驗證碼已寄出" : "簡訊驗證碼已寄出",
        megabankOtpMessage,
        megabankOtpSecondsRemaining,
      )}
      <div class="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label class="grid gap-1.5 text-sm font-medium">
          {connectorId === "fubon" ? "簡訊／Email 驗證碼" : "簡訊驗證碼"}
          <Input
            class="bg-card/80 tracking-[0.2em]"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern={connectorId === "fubon" ? "[0-9]{6}" : "[0-9]{4,8}"}
            maxlength={connectorId === "fubon" ? 6 : 8}
            placeholder={connectorId === "fubon"
              ? "6 位數字驗證碼"
              : "4-8 位數字驗證碼"}
            bind:value={megabankOtp}
          />
        </label>
        <Button
          class="self-end"
          size="sm"
          disabled={verifyMegabankOtp.isPending ||
            !otpPattern.test(megabankOtp.trim())}
          onclick={() => {
            error = "";
            verifyMegabankOtp.mutate();
          }}
          ><ShieldCheck class="size-4" />{verifyMegabankOtp.isPending
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
  {#if !captchaBank}
    <p class="mt-3 text-sm text-ink/50">
      {CONNECTOR_NOTES[connectorId] ??
        "輸入完帳號密碼後，請先按「儲存設定」，再按「同步」。"}
    </p>
  {/if}
</Card>
