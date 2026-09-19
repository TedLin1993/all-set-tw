import type { PrecheckItem } from "@/data/types";

export const checkLabels: Record<PrecheckItem["id"], string> = {
  workers_subdomain: "workers.dev 子網域",
  access_organization: "Zero Trust／Access 組織",
  worker_name: "Worker 名稱尚未被佔用",
  d1_name: "D1 資料庫名稱尚未被佔用",
  queue_name: "Queue 名稱尚未被佔用",
};

export function precheckSummary(checks: PrecheckItem[]) {
  const missing = checks.filter((check) => !check.ok);
  return {
    ready: missing.length === 0,
    missing,
  };
}
