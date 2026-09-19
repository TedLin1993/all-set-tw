export const INSTALL_PHASES = [
  {
    id: "prepare",
    label: "準備環境",
    steps: [
      "precheck",
      "load_release",
      "generate_keys",
      "create_d1",
      "create_queue",
      "deploy_bootstrap",
      "enable_workers_dev",
    ],
  },
  {
    id: "protect",
    label: "設定登入保護",
    steps: ["ensure_otp_idp", "create_access_app", "write_access_secrets"],
  },
  {
    id: "install",
    label: "安裝版本",
    steps: [
      "apply_migrations",
      "write_app_secrets",
      "upload_assets",
      "deploy_worker",
      "attach_queue_consumer",
      "attach_cron",
    ],
  },
  {
    id: "verify",
    label: "驗證完成",
    steps: ["verify_install", "finalize"],
  },
] as const;

export const UPDATE_PHASES = [
  {
    id: "prepare",
    label: "準備更新",
    steps: ["precheck_update", "load_release", "compare_versions"],
  },
  {
    id: "protect",
    label: "暫停同步",
    steps: ["enter_maintenance", "wait_inflight", "create_restore_point"],
  },
  {
    id: "install",
    label: "安裝版本",
    steps: [
      "apply_migrations",
      "verify_secrets",
      "upload_assets",
      "deploy_worker",
      "attach_queue_consumer",
    ],
  },
  {
    id: "verify",
    label: "恢復並驗證",
    steps: ["exit_maintenance", "verify_install", "finalize"],
  },
] as const;

export type JobProgress = {
  status: string;
  step: string;
  errorCode: string | null;
};

export type PhaseState = "pending" | "active" | "done" | "error";

export type PhaseId = "prepare" | "protect" | "install" | "verify";

export function phasesFor(kind: string) {
  return kind === "update" ? UPDATE_PHASES : INSTALL_PHASES;
}

export function phaseState(
  phaseId: PhaseId,
  progress: JobProgress,
  kind = "install",
): PhaseState {
  const phases = phasesFor(kind);
  const phase = phases.find((item) => item.id === phaseId);
  if (
    progress.status === "failed" &&
    phase &&
    (phase.steps as readonly string[]).includes(progress.step)
  ) {
    return "error";
  }
  if (progress.status === "succeeded") return "done";
  const currentIndex = phases.findIndex((item) =>
    (item.steps as readonly string[]).includes(progress.step),
  );
  const thisIndex = phases.findIndex((item) => item.id === phaseId);
  if (currentIndex < 0) return "pending";
  if (thisIndex < currentIndex) return "done";
  if (thisIndex > currentIndex) return "pending";
  return "active";
}

export function nextAction(errorCode: string | null) {
  switch (errorCode) {
    case "PRECHECK_INCOMPLETE":
      return "請先完成上方預檢列出的 Dashboard 步驟，再回來續跑。";
    case "RELEASE_UNAVAILABLE":
    case "RELEASE_DIGEST_MISMATCH":
      return "維護者尚未提供可安裝的版本包。版本發布後可直接續跑，不必重填資料。";
    case "TOKEN_EXPIRED":
      return "Cloudflare 授權已過期，請重新授權後續跑同一筆安裝。";
    case "RESOURCE_CONFLICT":
      return "目標帳戶已有同名資源。請更換 Worker 名稱，或確認那不是別人的安裝。";
    case "ACCESS_NOT_ENFORCED":
      return "網站還沒有套用登入保護，入口尚未開放。";
    case "TOO_MANY_ATTEMPTS":
      return "重試次數已達上限，請稍後再試或聯絡維護者。";
    case "UP_TO_DATE":
      return "目前已是這個版本，不需要更新。";
    case "UPGRADE_NOT_ALLOWED":
      return "這個版本尚未開放從此安裝來源更新。";
    case "INSTALL_NOT_READY":
      return "請先完成首次安裝，再執行更新。";
    case "SECRETS_MISSING":
      return "目標 Worker 缺少必要金鑰，更新已停止以免覆寫。請改走首次安裝或聯絡維護者。";
    default:
      return errorCode ? "工作尚未完成。請依錯誤說明處理後按「重試」。" : "";
  }
}

export function publicSiteUrl(
  workerName: string,
  createdResources: Record<string, unknown>,
) {
  const subdomain = createdResources.workersSubdomain;
  if (typeof subdomain !== "string" || !subdomain) return null;
  return `https://${workerName}.${subdomain}.workers.dev/`;
}

export function interruptionCopy(plan: {
  pendingMigrations: string[];
  interruption: { pauseSync: boolean; hasMigrations: boolean };
}) {
  if (plan.pendingMigrations.length > 0) {
    return `這次更新會暫停同步並套用 ${plan.pendingMigrations.length} 個資料庫變更。失敗時保留 D1 復原點，不會倒跑 SQL。`;
  }
  if (plan.interruption.pauseSync) {
    return "這次更新會短暫暫停同步，資料庫 schema 不變。";
  }
  return "這次主要更新程式與靜態資源，同步會短暫暫停。";
}

export function updateUnavailableCopy(
  reason:
    | "INSTALL_NOT_READY"
    | "RELEASE_UNAVAILABLE"
    | "UP_TO_DATE"
    | "UPGRADE_NOT_ALLOWED"
    | null,
) {
  switch (reason) {
    case "UP_TO_DATE":
      return "目前已是這個版本。";
    case "UPGRADE_NOT_ALLOWED":
      return "這個版本尚未開放從此安裝來源更新。";
    case "RELEASE_UNAVAILABLE":
      return "維護者尚未提供可安裝的版本包。發布後可再檢查更新。";
    case "INSTALL_NOT_READY":
      return "請先完成首次安裝，再執行更新。";
    default:
      return "";
  }
}
