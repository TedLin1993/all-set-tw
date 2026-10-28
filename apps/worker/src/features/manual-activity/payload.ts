import type { ManualActivityFx } from "@taiwan-fin-hub/shared";

/** 手動記錄 raw_payload（`{"origin":"manual","fx":...}`）裡的原幣資訊；無法解析時視為沒有外幣。 */
export function parseManualFx(value: string | null): ManualActivityFx | null {
  if (!value) return null;
  try {
    const fx = (JSON.parse(value) as { fx?: ManualActivityFx | null }).fx;
    return fx ?? null;
  } catch {
    return null;
  }
}
