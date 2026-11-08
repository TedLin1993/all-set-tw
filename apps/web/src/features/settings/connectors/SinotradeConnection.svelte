<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import {
    BadgeCheck,
    CalendarDays,
    CircleAlert,
    CircleCheckBig,
    Clock,
    KeyRound,
    LoaderCircle,
    RefreshCw,
    ScrollText,
    ShieldCheck,
    Smartphone,
    X,
  } from "@lucide/svelte";
  import type {
    SinotradeConnectionResponse,
    SinotradeVerificationAction,
    SinotradeVerificationField,
    SinotradeVerificationFieldKey,
    SinotradeVerificationInput,
  } from "@taiwan-fin-hub/shared";
  import type { ApiClient } from "@/shared/api/client";
  import Button from "@/shared/ui/Button.svelte";
  import Checkbox from "@/shared/ui/Checkbox.svelte";
  import Input from "@/shared/ui/Input.svelte";
  import Select from "@/shared/ui/Select.svelte";
  import Textarea from "@/shared/ui/Textarea.svelte";
  import SinotradeProgress from "./SinotradeProgress.svelte";

  type PendingConnection = Extract<
    SinotradeConnectionResponse,
    { status: "verification_required" }
  >;
  type VerificationValues = SinotradeVerificationInput["values"];
  type Operation = "connect" | "refresh" | "verify" | "complete" | "cancel";
  /** What the official page is currently being asked to do, for the waiting message. */
  type Working = Operation | "restore" | SinotradeVerificationAction;
  type AutomaticStep = { working: Working; path: string; body: unknown };

  const CONNECT_PATH = "/api/connectors/sinotrade/connect";
  const STATUS_PATH = "/api/connectors/sinotrade/connect/status";
  const VERIFY_PATH = "/api/connectors/sinotrade/connect/verify";
  const COMPLETE_PATH = "/api/connectors/sinotrade/connect/complete";
  const CANCEL_PATH = "/api/connectors/sinotrade/connect/cancel";
  // Loading the certificate and finishing a platform need no decision, so they follow the
  // action the user just took. The cap keeps a misbehaving page from looping.
  const MAX_AUTOMATIC_STEPS = 3;

  let {
    api,
    configured = false,
    credentialsComplete = false,
    sessionAvailable = false,
    verificationPending = false,
    sinotradePlatforms,
    synced = false,
    syncing = false,
    demoMode = false,
    disabled = false,
    busy = $bindable(false),
    onChanged,
    onConnected,
    onCancelled,
  }: {
    api: ApiClient;
    configured?: boolean;
    credentialsComplete?: boolean;
    sessionAvailable?: boolean;
    verificationPending?: boolean;
    sinotradePlatforms?: { newweb: boolean; savings: boolean };
    /** 已有成功的同步紀錄。 */
    synced?: boolean;
    /** 同步正在進行（手動或排程）。 */
    syncing?: boolean;
    demoMode?: boolean;
    disabled?: boolean;
    busy?: boolean;
    onChanged: () => Promise<void>;
    onConnected?: () => void;
    onCancelled?: () => void;
  } = $props();

  let pending = $state<PendingConnection | null>(null);
  let panel = $state<HTMLElement>();
  let values = $state<VerificationValues>({});
  let operation = $state<Operation | null>(null);
  let working = $state<Working | null>(null);
  let connected = $state(false);
  let error = $state("");
  let status = $state("");
  let notice = $state("");
  let otpSentVia = $state("");
  let now = $state(Date.now());
  let restoredPending = false;
  let destroyed = false;
  const verificationId = $props.id();

  const platformNames = { newweb: "新理財網", savings: "豐存股" } as const;
  const platformScopes = {
    newweb: "新理財網・台股與美股",
    savings: "豐存股",
  } as const;
  const actionLabels: Record<SinotradeVerificationAction, string> = {
    confirm_certificate: "確認憑證",
    request_otp: "寄送驗證碼",
    verify_otp: "送出驗證碼",
    submit_birthday: "確認生日",
    accept_terms: "同意並繼續",
  };
  const workingCopy: Record<Working, { title: string; detail: string }> = {
    connect: {
      title: "正在登入永豐證券",
      detail: "正在以已儲存的帳密登入官方網站，通常需要數秒。",
    },
    refresh: {
      title: "正在更新驗證狀態",
      detail: "只會重新讀取官方頁面目前的步驟，不會送出任何資料。",
    },
    restore: {
      title: "恢復連線驗證",
      detail: "正在讀取目前的驗證步驟，不會送出任何資料。",
    },
    verify: { title: "正在送出驗證", detail: "請稍候，不需要重複操作。" },
    complete: {
      title: "正在確認連線",
      detail: "正在確認登入，並檢查另一個平台是否也能查詢。",
    },
    cancel: { title: "正在取消連線", detail: "正在關閉這次連線驗證。" },
    confirm_certificate: {
      title: "正在載入電子憑證",
      detail: "官方網站正在準備下一個步驟。",
    },
    submit_birthday: {
      title: "正在確認生日",
      detail: "正在把生日交給官方網站核對。",
    },
    request_otp: {
      title: "正在寄送驗證碼",
      detail: "官方網站正在寄出驗證碼，請不要重複按。",
    },
    verify_otp: {
      title: "正在驗證驗證碼",
      detail: "正在把驗證碼交給官方網站核對。",
    },
    accept_terms: {
      title: "正在簽發並匯入憑證",
      detail:
        "官方網站正在簽發並匯入憑證，並等待官方系統登記，通常數十秒、最多約 1.5 分鐘，請稍候。",
    },
  };
  const iconTones = {
    steel: "bg-steel/10 text-steel",
    success: "bg-moss/10 text-moss",
    alert: "bg-coral/10 text-coral",
  } as const;
  const textWidths: Partial<Record<SinotradeVerificationFieldKey, string>> = {
    birthdayYear: "w-28",
    birthdayMonth: "w-20",
    birthdayDay: "w-20",
  };
  const datePlaceholders: Partial<
    Record<SinotradeVerificationFieldKey, string>
  > = { birthdayYear: "YYYY", birthdayMonth: "MM", birthdayDay: "DD" };

  const hasPending = $derived(pending !== null || verificationPending);
  const challenge = $derived(pending?.challenge);
  const blocked = $derived(challenge?.step === "blocked");
  const isBusy = $derived(busy || operation !== null);
  const canManagePending = $derived(!demoMode && !disabled && !isBusy);
  const canOperate = $derived(
    configured && credentialsComplete && canManagePending,
  );
  const platforms = $derived(
    sinotradePlatforms ?? {
      newweb: sessionAvailable,
      savings: sessionAvailable,
    },
  );
  const secondsRemaining = $derived(
    pending
      ? Math.max(0, Math.ceil((Date.parse(pending.expiresAt) - now) / 1000))
      : null,
  );
  const expired = $derived(
    secondsRemaining !== null &&
      (!Number.isFinite(secondsRemaining) || secondsRemaining <= 0),
  );
  const countdown = $derived(
    secondsRemaining !== null && Number.isFinite(secondsRemaining)
      ? `${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, "0")}`
      : "0:00",
  );
  const showCountdown = $derived(pending !== null && !expired && !blocked);
  const urgent = $derived(secondsRemaining !== null && secondsRemaining <= 60);

  // 進度：登入憑證、新理財網、豐存股、首次同步；第一個未完成的步驟是目前步驟。
  const progress = $derived.by(() => {
    const credentialsSaved = configured && credentialsComplete;
    const newwebDone = credentialsSaved && platforms.newweb;
    const savingsDone = newwebDone && platforms.savings;
    const syncDone = savingsDone && synced && !syncing;
    let currentFound = false;
    return [credentialsSaved, newwebDone, savingsDone, syncDone].map(
      (done): "done" | "current" | "todo" => {
        if (done) return "done";
        if (currentFound) return "todo";
        currentFound = true;
        return "current";
      },
    );
  });
  const progressVisible = $derived(progress.some((state) => state !== "done"));
  const progressHint = $derived.by(() => {
    const current = progress.indexOf("current");
    if (current === 0)
      return "先在下方填入身分證字號與證券網路密碼，再按上方「連線並同步」。";
    if (current === 1 || current === 2)
      return "登入憑證已儲存。按上方「連線並同步」開始，官方要求的資料會在這裡依序輸入。";
    return syncing
      ? "正在取得台股、美股與豐存股的持倉與損益…"
      : "兩個平台都已驗證，按上方「同步」取得持倉與損益。";
  });

  type View =
    | "busy"
    | "connected"
    | "restoring"
    | "expired"
    | "blocked"
    | "ready"
    | "step";
  const view = $derived.by((): View | null => {
    if (isBusy) return "busy";
    if (!hasPending) return connected && progressVisible ? "connected" : null;
    if (!pending) return "restoring";
    if (expired) return "expired";
    if (pending.challenge.step === "blocked") return "blocked";
    if (pending.challenge.step === "ready") return "ready";
    return "step";
  });
  const platformName = $derived(pending ? platformNames[pending.platform] : "");
  const hasOtpField = $derived(
    challenge?.fields.some((field) => field.key === "otp") ?? false,
  );
  const header = $derived.by(() => {
    switch (view) {
      case "busy": {
        const copy = workingCopy[working ?? "verify"];
        return {
          icon: LoaderCircle,
          tone: "steel" as const,
          title: copy.title,
          description: copy.detail,
        };
      }
      case "connected":
        return {
          icon: CircleCheckBig,
          tone: "success" as const,
          title: "已連線永豐證券",
          description: "台股、美股與豐存股都已完成驗證，可以同步持倉資料。",
        };
      case "restoring":
        return {
          icon: LoaderCircle,
          tone: "steel" as const,
          title: "恢復連線驗證",
          description:
            "正在讀取目前的驗證步驟；沒有反應時可按「更新驗證狀態」。",
        };
      case "expired":
        return {
          icon: CircleAlert,
          tone: "alert" as const,
          title: "驗證已逾時",
          description: "這次連線的等待時間已用完，請重新開始。",
        };
      case "blocked":
        return {
          icon: CircleAlert,
          tone: "alert" as const,
          title: "連線未完成",
          description: challenge?.message,
        };
      case "ready":
        return {
          icon: CircleCheckBig,
          tone: "success" as const,
          title: `${platformName}驗證完成`,
          description: "這個平台的登入驗證已完成，按「確認並繼續」完成這一步。",
        };
      case "step":
        switch (challenge?.step) {
          case "certificate":
            return {
              icon: BadgeCheck,
              tone: "steel" as const,
              title: "載入電子憑證",
              description:
                challenge.message ?? "官方網站要先載入電子憑證才能繼續登入。",
            };
          case "birthday":
            return {
              icon: CalendarDays,
              tone: "steel" as const,
              title: "輸入出生年月日",
              description:
                challenge.message ??
                "官方憑證需要核對生日，只用於這次驗證，不會儲存。",
            };
          case "otp":
            return hasOtpField
              ? {
                  icon: KeyRound,
                  tone: "steel" as const,
                  title: "輸入驗證碼",
                  description:
                    challenge?.message ?? "驗證碼已寄出，請輸入收到的驗證碼。",
                }
              : {
                  icon: Smartphone,
                  tone: "steel" as const,
                  title: "選擇驗證碼收取方式",
                  description:
                    challenge?.message ??
                    "請選擇收取方式，再按「寄送驗證碼」；系統不會自動寄送。",
                };
          case "terms":
            return {
              icon: ScrollText,
              tone: "steel" as const,
              title: "同意憑證作業條款",
              description:
                challenge.message ??
                "官方要求同意憑證作業條款，同意後才會簽發並匯入憑證。",
            };
        }
    }
    return null;
  });
  const primaryAction = $derived.by(() => {
    const actions = challenge?.actions ?? [];
    const preferred: SinotradeVerificationAction | undefined =
      challenge?.step === "terms"
        ? "accept_terms"
        : challenge?.step === "birthday"
          ? "submit_birthday"
          : challenge?.step === "certificate"
            ? "confirm_certificate"
            : challenge?.step === "otp"
              ? hasOtpField
                ? "verify_otp"
                : "request_otp"
              : undefined;
    return preferred && actions.includes(preferred) ? preferred : actions[0];
  });
  const orderedActions = $derived(
    primaryAction
      ? [
          primaryAction,
          ...(challenge?.actions ?? []).filter(
            (action) => action !== primaryAction,
          ),
        ]
      : [],
  );

  function errorMessage(value: unknown) {
    return value instanceof Error
      ? value.message
      : "連線操作失敗，請稍後再試。";
  }

  function applyConnectionResponse(response: SinotradeConnectionResponse) {
    const nextValues: VerificationValues = {};
    if (response.status === "verification_required") {
      for (const field of response.challenge.fields) {
        if (field.type === "choice" && field.value) {
          nextValues[field.key] = field.value;
        }
      }
      if (response.challenge.step !== "otp") otpSentVia = "";
      if (pending && pending.platform !== response.platform)
        notice = `${platformNames[pending.platform]}已完成驗證，接著驗證${platformNames[response.platform]}。`;
    }
    values = nextValues;
    if (response.status === "connected") {
      pending = null;
      connected = true;
      return;
    }
    connected = false;
    pending = response;
    now = Date.now();
  }

  /** Only the choices stay while a request is out; typed values and consent are asked again. */
  function choiceValues() {
    const kept: VerificationValues = {};
    for (const field of pending?.challenge.fields ?? []) {
      const value = values[field.key];
      if (field.type === "choice" && value) kept[field.key] = value;
    }
    return kept;
  }

  function automaticStep(
    response: SinotradeConnectionResponse,
  ): AutomaticStep | null {
    if (response.status !== "verification_required") return null;
    const { step, fields, actions } = response.challenge;
    if (step === "ready")
      return { working: "complete", path: COMPLETE_PATH, body: {} };
    if (
      step === "certificate" &&
      fields.length === 0 &&
      actions.length === 1 &&
      actions[0] === "confirm_certificate"
    )
      return {
        working: "confirm_certificate",
        path: VERIFY_PATH,
        body: {
          action: "confirm_certificate",
          values: {},
        } satisfies SinotradeVerificationInput,
      };
    return null;
  }

  async function runOperation(
    nextOperation: Operation,
    path: string,
    body: unknown = {},
    label: Working = nextOperation,
  ) {
    if (
      nextOperation === "connect" || nextOperation === "verify"
        ? !canOperate
        : !canManagePending
    )
      return false;
    const wasExpired = expired;
    operation = nextOperation;
    working = label;
    busy = true;
    error = "";
    status = "";
    notice = "";
    connected = false;
    values = choiceValues();
    let successful = false;
    let connectionCompleted = false;
    try {
      if (nextOperation === "cancel") {
        const response = await api.post<{ success: true }>(path, body);
        if (response.success !== true)
          throw new Error("取消驗證尚未完成，請重新嘗試。");
        if (destroyed) return false;
        pending = null;
        status = wasExpired
          ? "已清除逾時的驗證，請按「連線並同步」重新開始。"
          : "已取消連線驗證，可重新連線。";
        onCancelled?.();
      } else {
        let response = await api.post<SinotradeConnectionResponse>(path, body);
        for (let hops = 0; ; hops++) {
          if (destroyed) return false;
          applyConnectionResponse(response);
          const next =
            nextOperation === "refresh" || hops >= MAX_AUTOMATIC_STEPS
              ? null
              : automaticStep(response);
          if (!next) break;
          working = next.working;
          response = await api.post<SinotradeConnectionResponse>(
            next.path,
            next.body,
          );
        }
        connectionCompleted = response.status === "connected";
      }
      successful = true;
    } catch (value) {
      if (!destroyed) error = errorMessage(value);
    } finally {
      let refreshed = false;
      try {
        if (!destroyed) {
          await onChanged();
          refreshed = true;
        }
      } catch {
        if (!destroyed && !error)
          error = "連線狀態暫時無法更新，請重新整理頁面。";
      }
      operation = null;
      working = null;
      busy = false;
      if (!destroyed && connectionCompleted && refreshed) {
        await tick();
        if (!destroyed) onConnected?.();
      } else if (
        !destroyed &&
        successful &&
        nextOperation !== "refresh" &&
        nextOperation !== "cancel"
      ) {
        await tick();
        focusFirstControl();
      }
    }
    return successful;
  }

  function focusFirstControl() {
    panel
      ?.querySelector<HTMLElement>(
        "section form :is(input, select):not([disabled])",
      )
      ?.focus({ preventScroll: true });
  }

  export async function connect() {
    if (hasPending) {
      panel?.scrollIntoView({ block: "nearest" });
      return false;
    }
    return runOperation("connect", CONNECT_PATH);
  }

  function refreshPending(label: Working = "refresh") {
    if (!hasPending) return;
    return runOperation("refresh", STATUS_PATH, {}, label);
  }

  function fieldsForAction(action: SinotradeVerificationAction) {
    return (pending?.challenge.fields ?? []).filter(
      (field) => field.action === action,
    );
  }

  function canVerify(action: SinotradeVerificationAction) {
    return (
      canOperate &&
      !expired &&
      pending?.challenge.step !== "blocked" &&
      pending?.challenge.actions.includes(action) &&
      fieldsForAction(action).every((field) =>
        Boolean(values[field.key]?.trim()),
      )
    );
  }

  async function verify(action: SinotradeVerificationAction) {
    if (!canVerify(action)) return;
    const submittedValues: VerificationValues = {};
    for (const field of fieldsForAction(action)) {
      const value = values[field.key]?.trim();
      if (value) submittedValues[field.key] = value;
    }
    const input: SinotradeVerificationInput = {
      action,
      values: submittedValues,
    };
    const channel = fieldsForAction(action)
      .find((field) => field.key === "otpChannel")
      ?.options?.find((option) => option.value === values.otpChannel)?.label;
    const successful = await runOperation("verify", VERIFY_PATH, input, action);
    if (
      successful &&
      channel &&
      pending?.challenge.fields.some((field) => field.key === "otp")
    )
      otpSentVia = channel;
    return successful;
  }

  function submitPrimary(event: SubmitEvent) {
    event.preventDefault();
    if (primaryAction) void verify(primaryAction);
  }

  function actionLabel(action: SinotradeVerificationAction) {
    return action === "request_otp" && hasOtpField
      ? "重新寄送驗證碼"
      : actionLabels[action];
  }

  function complete() {
    if (pending?.challenge.step !== "ready" || expired) return;
    return runOperation("complete", COMPLETE_PATH);
  }

  function cancel() {
    if (!hasPending) return;
    return runOperation("cancel", CANCEL_PATH);
  }

  $effect(() => {
    if (!verificationPending || demoMode || disabled || !panel) return;
    untrack(() => {
      if (
        restoredPending ||
        pending ||
        operation ||
        !panel?.getClientRects().length
      )
        return;
      restoredPending = true;
      void refreshPending("restore");
    });
  });

  // 逾時後官方工作階段已無法完成；頁面仍開著就自動關閉，不讓 Browser 閒置到逾時才結束而
  // 佔用 Browser Run 額度。每次驗證只自動取消一次，失敗時保留手動取消。
  let autoCancelledAt = "";
  $effect(() => {
    if (!expired || !pending || !canManagePending) return;
    const expiresAt = pending.expiresAt;
    untrack(() => {
      if (autoCancelledAt === expiresAt) return;
      autoCancelledAt = expiresAt;
      void cancel();
    });
  });

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  onDestroy(() => {
    destroyed = true;
    values = {};
    busy = false;
  });
</script>

{#snippet fieldControl(field: SinotradeVerificationField)}
  {@const fieldType = field.type ?? "text"}
  {@const id = `${verificationId}-${field.key}`}
  {@const hintId = field.hint ? `${id}-hint` : undefined}
  {#if fieldType === "checkbox"}
    <div class="grid w-full gap-1.5 text-sm font-medium">
      <label for={id} class="flex items-start gap-2">
        <Checkbox
          {id}
          name={`sinotrade-verification-${field.key}`}
          aria-describedby={hintId}
          checked={values[field.key] === "true"}
          disabled={!canOperate}
          onchange={(event: Event) => {
            values[field.key] = (event.currentTarget as HTMLInputElement)
              .checked
              ? "true"
              : undefined;
          }}
        />
        <span>{field.label}</span>
      </label>
      {@render fieldHint(hintId, field.hint)}
    </div>
  {:else if fieldType === "choice" && (field.options?.length ?? 0) <= 3}
    <div
      role="radiogroup"
      aria-labelledby={`${id}-label`}
      aria-describedby={hintId}
      class="grid w-full gap-1.5"
    >
      <span id={`${id}-label`} class="text-sm font-medium">{field.label}</span>
      <div class="flex flex-wrap gap-2">
        {#each field.options ?? [] as option (option.value)}
          <label
            class="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs transition-colors has-[:checked]:border-steel has-[:checked]:bg-steel/10 has-[:checked]:font-semibold has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
          >
            <input
              type="radio"
              class="size-4 accent-primary"
              name={`sinotrade-verification-${field.key}`}
              value={option.value}
              checked={values[field.key] === option.value}
              disabled={!canOperate}
              onchange={() => {
                values[field.key] = option.value;
              }}
            />
            {option.label}
          </label>
        {/each}
      </div>
      {@render fieldHint(hintId, field.hint)}
    </div>
  {:else if fieldType === "choice"}
    <div class="grid w-full gap-1.5 text-sm font-medium">
      <label for={id}>{field.label}</label>
      <Select
        {id}
        name={`sinotrade-verification-${field.key}`}
        aria-describedby={hintId}
        value={values[field.key] ?? ""}
        disabled={!canOperate}
        onchange={(event: Event) => {
          values[field.key] = (event.currentTarget as HTMLSelectElement).value;
        }}
      >
        {#if !field.value}
          <option value="" disabled>請選擇</option>
        {/if}
        {#each field.options ?? [] as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </Select>
      {@render fieldHint(hintId, field.hint)}
    </div>
  {:else}
    <div
      class={`grid gap-1.5 text-sm font-medium ${textWidths[field.key] ?? "w-full sm:w-64"}`}
    >
      <label for={id}>{field.label}</label>
      <Input
        {id}
        name={`sinotrade-verification-${field.key}`}
        aria-describedby={hintId}
        inputmode="numeric"
        autocomplete={field.key === "otp" ? "one-time-code" : "off"}
        placeholder={datePlaceholders[field.key] ??
          field.hint?.match(/[YMD][YMD-]{4,}/)?.[0]}
        maxlength={field.maxLength}
        disabled={!canOperate}
        bind:value={values[field.key]}
      />
      {@render fieldHint(hintId, field.hint)}
    </div>
  {/if}
{/snippet}

{#snippet fieldHint(id: string | undefined, hint?: string)}
  {#if hint}
    <span {id} class="text-xs font-normal text-muted-foreground">{hint}</span>
  {/if}
{/snippet}

{#snippet recoveryActions(withRefresh: boolean)}
  {#if withRefresh}
    <Button
      size="sm"
      variant="ghost"
      disabled={!canManagePending}
      onclick={() => void refreshPending()}
    >
      <RefreshCw class="size-4" />更新驗證狀態
    </Button>
  {/if}
  <Button
    size="sm"
    variant="ghost"
    disabled={!canManagePending}
    onclick={() => void cancel()}
  >
    <X class="size-4" />取消驗證
  </Button>
{/snippet}

<div bind:this={panel}>
  {#if progressVisible}
    <SinotradeProgress
      states={progress}
      {syncing}
      hint={view ? "" : progressHint}
      showHelp={!view}
    />
  {/if}

  {#if view && header}
    {@const Icon = header.icon}
    <section
      aria-label="永豐證券連線驗證"
      class="mt-4 overflow-hidden rounded-xl border border-steel/20 bg-steel/[0.045]"
    >
      <div
        class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3"
      >
        <div class="flex min-w-0 items-start gap-3">
          <span
            class={`grid size-9 shrink-0 place-items-center rounded-full ${iconTones[header.tone]}`}
          >
            <Icon
              class={view === "busy" ? "size-4.5 animate-spin" : "size-4.5"}
            />
          </span>
          <div class="min-w-0" aria-live="polite">
            {#if pending && view !== "busy"}
              <p class="text-xs font-semibold text-steel">
                {platformScopes[pending.platform]}
              </p>
            {/if}
            <h3 class="text-sm font-semibold text-ink">{header.title}</h3>
            {#if header.description}
              <p
                class="mt-0.5 whitespace-pre-line text-sm leading-relaxed text-ink/60"
              >
                {header.description}
              </p>
            {/if}
            {#if view === "step" && hasOtpField && otpSentVia}
              <p class="mt-0.5 text-sm text-ink/60">
                寄送方式：{otpSentVia}
              </p>
            {/if}
            {#if notice}
              <p class="mt-1 text-sm font-medium text-moss">{notice}</p>
            {/if}
          </div>
        </div>
        {#if showCountdown}
          <p
            class={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${urgent ? "text-coral" : "text-steel"}`}
          >
            <Clock class="size-3.5" />請於 {countdown} 內完成驗證
          </p>
        {/if}
      </div>

      {#if error}
        <p
          role="alert"
          class="border-t border-coral/20 bg-coral/[0.06] px-4 py-2 text-sm font-medium text-coral"
        >
          {error}
        </p>
      {/if}

      {#if view === "step" && challenge}
        <form class="border-t border-steel/15" onsubmit={submitPrimary}>
          <div class="grid gap-4 p-4">
            {#if challenge.document}
              <Textarea
                readonly
                rows={7}
                aria-label={challenge.document.title}
                class="resize-none bg-card text-xs leading-relaxed"
                value={challenge.document.text}
              />
            {/if}
            {#if challenge.fields.length}
              <div class="flex flex-wrap items-start gap-3">
                {#each challenge.fields as field (field.key)}
                  {@render fieldControl(field)}
                {/each}
              </div>
            {/if}
            <div class="flex flex-wrap items-center gap-2">
              {#each orderedActions as action (action)}
                {@const primary = action === primaryAction}
                <Button
                  size="sm"
                  type={primary ? "submit" : "button"}
                  variant={primary ? "default" : "outline"}
                  disabled={!canVerify(action)}
                  onclick={primary ? undefined : () => void verify(action)}
                >
                  {#if primary}<ShieldCheck class="size-4" />{/if}{actionLabel(
                    action,
                  )}
                </Button>
              {/each}
              <span class="flex flex-wrap gap-1 sm:ml-auto">
                {@render recoveryActions(true)}
              </span>
            </div>
          </div>
        </form>
      {:else if view === "ready"}
        <div
          class="flex flex-wrap items-center gap-2 border-t border-steel/15 p-4"
        >
          <Button
            size="sm"
            disabled={!canManagePending}
            onclick={() => void complete()}
          >
            <ShieldCheck class="size-4" />確認並繼續
          </Button>
          <span class="flex flex-wrap gap-1 sm:ml-auto">
            {@render recoveryActions(true)}
          </span>
        </div>
      {:else if view === "blocked"}
        <div class="grid gap-3 border-t border-steel/15 p-4">
          <p class="text-sm text-muted-foreground">
            目前沒有可提交的驗證欄位。可重新檢查連線狀態，或取消這次連線。
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canManagePending}
              onclick={() => void refreshPending()}
            >
              <RefreshCw class="size-4" />重新檢查連線
            </Button>
            {@render recoveryActions(false)}
          </div>
        </div>
      {:else if view === "expired"}
        <div class="border-t border-steel/15 p-4">
          <Button
            size="sm"
            disabled={!canManagePending}
            onclick={() => void cancel()}
          >
            <RefreshCw class="size-4" />重新開始
          </Button>
        </div>
      {:else if view === "restoring"}
        <div
          class="flex flex-wrap items-center gap-1 border-t border-steel/15 p-4"
        >
          {@render recoveryActions(true)}
        </div>
      {/if}
    </section>
  {/if}

  {#if status}
    <p role="status" class="mt-3 text-sm text-muted-foreground">{status}</p>
  {/if}
  {#if error && !view}
    <p
      role="alert"
      class="mt-3 rounded-lg border border-coral/20 bg-coral/[0.06] px-3 py-2 text-sm font-medium text-coral"
    >
      {error}
    </p>
  {/if}
  {#if demoMode}
    <p class="mt-3 text-sm text-muted-foreground">Demo site 已停用連線驗證。</p>
  {/if}
</div>
