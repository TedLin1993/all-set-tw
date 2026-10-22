/** 臺灣金融機構代碼與顯示名稱。 */
export const TAIWAN_BANK_NAMES: Readonly<Record<string, string>> = {
  "004": "台灣銀行",
  "005": "土地銀行",
  "006": "合作金庫銀行",
  "007": "第一銀行",
  "008": "華南銀行",
  "009": "彰化銀行",
  "011": "上海商銀",
  "012": "台北富邦銀行",
  "013": "國泰世華銀行",
  "016": "高雄銀行",
  "017": "兆豐銀行",
  "048": "王道銀行",
  "050": "台灣企銀",
  "052": "渣打銀行",
  "053": "台中銀行",
  "054": "京城銀行",
  "081": "匯豐銀行",
  "103": "新光銀行",
  "108": "陽信銀行",
  "700": "中華郵政",
  "803": "聯邦銀行",
  "805": "遠東銀行",
  "806": "元大銀行",
  "807": "永豐銀行",
  "808": "玉山銀行",
  "809": "凱基銀行",
  "810": "星展銀行",
  "812": "台新銀行",
  "816": "安泰銀行",
  "822": "中國信託銀行",
  "823": "將來銀行",
  "824": "連線銀行",
  "826": "樂天銀行",
};

const SHORT_NAMES = Object.entries(TAIWAN_BANK_NAMES)
  .map(([code, name]) => ({
    code,
    short: name.replace(/(?:商業)?銀行$/, ""),
  }))
  .filter((item) => item.short.length >= 2);

/**
 * 以銀行頁面上的機構名稱（例如「台北富邦」「國泰世華銀行」）推得金融機構代碼。
 * 取最長的相符名稱，避免「台灣」誤判「台灣企銀」；無法辨識時回傳 undefined。
 */
export function bankCodeFromName(label: string) {
  const text = label.replace(/臺/g, "台").replace(/\s+/g, "");
  let best: { code: string; short: string } | undefined;
  for (const item of SHORT_NAMES) {
    if (!text.startsWith(item.short)) continue;
    if (!best || item.short.length > best.short.length) best = item;
  }
  return best?.code;
}
