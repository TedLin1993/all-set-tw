import type {
  ScheduledSyncReport,
  SyncFinancialChangeUnavailableReason,
} from "@taiwan-fin-hub/core";

export type SyncReportStatusPresentation = {
  label: string;
  description: string;
  tone: "success" | "warning";
};

export function financialChangeScopeMessage(report: ScheduledSyncReport) {
  const { success, total } = report.sourceSummary;
  if (report.status === "success" || total === 0 || success >= total) {
    return null;
  }
  return `依 ${success}/${total} 已更新來源計算，其餘沿用上次資料`;
}

export function syncReportRecoveryMessage(report: ScheduledSyncReport) {
  return report.recoveredAt;
}

export function syncReportStatusPresentation(
  report: ScheduledSyncReport,
): SyncReportStatusPresentation {
  const { success, failed, needsUserAction, total } = report.sourceSummary;
  if (report.status === "success") {
    return {
      label: "同步完成",
      description: `${success} 個資料來源已完成`,
      tone: "success",
    };
  }
  const pending = failed + needsUserAction;
  return {
    label: needsUserAction > 0 ? "同步完成，需要處理" : "同步完成，部分失敗",
    description: `${success} / ${total} 個來源完成，${pending} 個未更新`,
    tone: "warning",
  };
}

export function financialChangeUnavailableMessage(
  reason: SyncFinancialChangeUnavailableReason | null,
) {
  if (reason === "baseline") return "這是第一份同步報告，已建立資產基準。";
  if (reason === "partial_sync")
    return "部分資料來源未更新，變化包含沿用的上次資料。";
  if (reason === "snapshot_unavailable") return "這次沒有完整的資產比較資料。";
  return null;
}

export function zeroRateCurrenciesMessage(missingCurrencies: string[]) {
  if (missingCurrencies.length === 0) return null;
  return `缺少 ${missingCurrencies.join("、")} 匯率，相關資產以 NT$0 計算。`;
}

export function signedFinancialChange(
  value: number,
  positiveChangeIsFavorable = true,
) {
  if (value > 0) {
    return {
      sign: "+",
      tone: positiveChangeIsFavorable
        ? ("positive" as const)
        : ("negative" as const),
    };
  }
  if (value < 0) {
    return {
      sign: "−",
      tone: positiveChangeIsFavorable
        ? ("negative" as const)
        : ("positive" as const),
    };
  }
  return { sign: "", tone: "neutral" as const };
}
