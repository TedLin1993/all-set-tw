# 中信信用卡明細、分頁與卡片顯示

Refs #269。既有 parser 已有帳單、未出帳及即時授權處理；本次補齊取數與顯示缺口，不重做 App 登入。

## 欄位與唯讀路徑

依公開中信行銀 Android 5.2.26 程式核對，並以本機去識別診斷確認欄位結構。套件來源與簽章核對範圍見[外幣研究](ctbc-foreign-deposits.md)。

| 查詢                    | 已核對的參數／回應                                                                            | 用途                           |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| `/twrbm-card/qu002/010` | `rsData.billCycle`、`billData`、`cardDataList`、`curDataList`                                 | 可用帳期、摘要、卡片及初始明細 |
| `/twrbm-card/qu002/011` | `curCode`、`month`、`billCycle`；`summary`、`bills`、`displayPaging`、`pageCount`、`totalRow` | 指定帳期明細                   |
| `/twrbm-card/qu002/016` | `curCode`、`month`、`pageNum`；`bills`                                                        | 帳單後續頁                     |
| `/twrbm-card/qu006/010` | `rsData.curOptions[].curCode`                                                                 | 未出帳幣別                     |
| `/twrbm-card/qu006/011` | `curCode`；`allItems`、`displayPaging`、`pageCount`、`totalRow`                               | 已入帳但尚未結帳               |
| `/twrbm-card/qu006/015` | `pageNum`，同 session                                                                         | 未出帳後續頁                   |
| `/twrbm-card/qu041/010` | `allItems`、`noMore`、`pageCount`、`totalRow`                                                 | 即時授權                       |
| `/twrbm-card/qu041/015` | `pageNum`                                                                                     | 授權後續頁                     |

正常同步依各幣別最近三個可用帳期查完整明細；獨立測試入口只查最新一期 TWD。未結帳摘要 `summary: null` 不當成已結帳帳期。

即時授權使用 `noMore` 判斷分頁，不能沿用其他 feed 的 `displayPaging`。必要頁缺漏、非法分頁、超過 20 頁或總筆數不符皆明確失敗，不截斷後宣稱成功。`qu006` 官方明確以 `8888` 作無未出帳結果，只有無交易且無矛盾總筆數才接受，其他 feed 不共用這個例外。

帳單／未出帳為 `posted`，即時授權為 `pending`。沿用授權與已入帳的配對規則，不用交易合計覆寫帳單應繳。資產頁新增「查看信用卡交易與待入帳」入口，消費月份可能與帳單月份不同。

## 卡名對照缺漏

測試 D1 的布林檢查確認卡名已保存但末碼缺漏；`fetchCtbcCardStatements` 與保存流程沒有丟掉整份 `cardDataList`。舊 `last4(cardNoSuffixFour || cardNo)` 會讓非空但不可解析的第一欄阻斷第二欄。

使用者自行登入、App 核准，只查一次既有 `/qu002/010`，不查其他明細、不寫 D1。回報固定診斷確認非空末碼欄位不可解析、`cardNo` 備援可用，並有可解析的卡名對照；無需新增銀行端點。不保留欄位值、筆數或原始回應。

修正分別解析兩欄再備援；若有效末碼矛盾，保持未知。公開 qu002／qu041 的 `removeTrailingUnderscore` 顯示末碼前先移除尾端 `_…` 標記，本次也支援該格式；這項支援依公開程式及合成測試，未將其記為使用者資料已確認的格式。

- 只有四位數字末碼唯一匹配非空卡名，才顯示「卡名 · 末四碼」。重複末碼、缺欄、矛盾或損壞資料顯示「未辨識卡片」。
- 分卡僅影響交易呈現，既有按幣別的共同帳戶、帳單與負債快照不拆分，也不重複計算。
- `displayCardLast4` 與原生命週期的 `cardLast4` 分開，保留原 match key、source ID 及授權去重算法。
- API 只內部讀取正規化末碼與 `cards`，回覆移除查表欄位，不傳出原始 payload。明確無法辨識的新顯示末碼不退回舊末碼。
- 舊 D1 已遺失的末碼不能猜回，須使用者重新同步既有範圍取得，不做資料遷移。

## 驗證與限制

2026-10-15 有限本機真實查詢：最新一期 TWD 已結帳、當期 TWD 未出帳及即時授權皆有非空資料並解析成功，不保存原始回應。帳單 `ntAmt` 為 string；未出帳 `purchaseAmt` 與授權 `txnAmt` 為 number；分頁型別亦已核對。

獨立測試站寫入測試 D1 後，使用者重新同步並確認卡名與交易可見。這是實測顯示結果，不等於所有交易／日期／金額、帳期、多幣別與真實多頁皆逐筆驗收。

合成測試涵蓋分頁、同額多筆、授權狀態、空資料及截斷失敗；隔離 D1 經真正 connector 與 API 驗證重新同步不新增重複帳戶／帳單／交易，分卡不複製共同負債。原測試部署基準完整後端 53 檔、477 案例通過；PR 移植到最新上游的檢查另列於 PR 說明。

本機最小診斷：`node scripts/inspect-ctbc-overview.mjs --card-metadata`。執行前確認範圍，由本人輸入憑證與 App 核准；僅輸出白名單路徑／型別與固定布林狀態，不保存原始資料。不可公開帳務截圖或 Network 匯出。
