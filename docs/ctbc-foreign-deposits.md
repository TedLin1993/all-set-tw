# 中信外幣存款研究與驗證

Refs [#269](https://github.com/TedLin1993/all-set-tw/issues/269)。本次涵蓋外幣活存帳戶、餘額及交易解析；定存不在範圍。銀行端僅唯讀，原始回應與憑證不放入 fixture、日誌或公開文件。沿用既有 App 核准與接續登入，不重做 #244。

## 現有總覽與資料來源

原程式僅解析 `/twrbm-deposit/qu001/010` 的 `rsData.twdAcctSummaryResponse.demDepBalSummaryResponse.infoList`，幣別固定 TWD。有限真實去識別檢查確認該次回應沒有 `fxAcctSummaryResponse`，需要外幣總覽；不推論所有帳戶或未來版本皆相同。

實作先檢查既有總覽：有外幣區塊就沿用，缺少時才查 `/twrbm-fx/qu001/010`；區塊存在但損壞則失敗，不以額外請求掩蓋不一致。

來源為[公開中信行銀 Android 套件](https://www.apkmirror.com/apk/ctbc-bank/china-trust-action-bank/) 5.2.26、build 2026081201、package `com.chinatrust.mobilebank`。僅解壓讀取，不安裝或執行。

- Base APK SHA-256：`0bd49e4022b75a9a2ec9c2a7b4d0608949438f241695031101477ee52588e1d3`。
- APK v2 內容摘要及 RSA SHA-256 簽章自洽，憑證 subject 為 `O=Chinatrust Commercial Bank`，憑證 SHA-256 為 `cf4e0ef454a81fc94352352cadda0c978caffa76b34aebeb99c46d075e62ffd9`；此核對不等同獨立驗證 Google Play 信任鏈。
- 總覽 asset：`projects_base-app_src_app_twrbm-fx_twrbm-fx-qu001_twrbm-fx-qu001_module_ts.2926fb51927a7d71.js`。
- 明細 asset：`projects_base-app_src_app_twrbm-fx_twrbm-fx-qu002_twrbm-fx-qu002_module_ts.91237de47289811d.js`。
- 網銀 `twrbc` 與行銀 `twrbm` 不同，沒有猜測前綴替換或混用欄位。

## 欄位映射

有限真實結構檢查確認總覽 `accountId`、`accountNickName`、`curCode`、`curName`、`currentBal`、`currentBalTwd`、`digiSvType`、`rspCode` 為 string；初始化 `accountId`、`curCode`、`currentBal`、`avialBal` 亦為 string。

單一帳戶／幣別及已確認的單月本機唯讀查詢取得非空 `detailList` 並解析成功。交易列 `acctId`、`actDtFull`、`balAmt`、`creditAmt`、`debitAmt`、`inOutAmt`、`memo1`、`memo2`、`trnDtRaw`、`userMemo` 為 string。未保存原始回應或任何欄位值；型別及解析成功不代表金額、方向、日期逐項核對成功。

| 端點／欄位                                              | 契約與對應                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/twrbm-fx/qu001/010`                                   | 外幣總覽，無指定投資組合時送空查詢                                                                         |
| `rsData.fxAcctSummaryResponse.demDepBalSummaryResponse` | 外幣活存分項物件                                                                                           |
| `rspCode`、`infoList`                                   | `0000` 與陣列才作成功解析；空陣列為無活存                                                                  |
| `rspCode: 9002 / 9004`                                  | 官方 UI 分類為無活存；不能同時帶有帳戶列                                                                   |
| `infoList[].accountId`、`curCode`                       | 非空帳戶識別、ISO 三碼幣別；不接受遮蔽帳戶或回退為 TWD                                                     |
| `infoList[].currentBal`                                 | 原幣餘額，number 或可解析金額字串，包含零餘額                                                              |
| `currentBalTwd`、`fxAcctSummaryTotalAmount`             | 折合台幣，不作原幣餘額                                                                                     |
| `/twrbm-fx/qu002/010`                                   | 送 `accountId`、`curCode` 初始化明細；必須在 `rsData.infoList` 唯一匹配同帳號、同幣別                      |
| 初始化的 `currentBal`、`avialBal`                       | 同次初始化的餘額及可用餘額；`avialBal` 沿用銀行拼字，不猜別名                                              |
| `/twrbm-fx/qu002/011`                                   | 送 `accountId`、`curCode`、`startDate`、`endDate`、空 `keyWord`、`type: custom`、`isFromEnterPrise: false` |
| `rsData.detailList`                                     | 完整交易陣列，不套信用卡頁數上限，不截取前幾筆                                                             |
| `debitAmt`、`creditAmt`                                 | 支出為負數、收入為正數；雙方同時非零或無法解析時失敗                                                       |
| `trnDtRaw`、`actDtFull`                                 | 交易日期、記帳日期；缺少記帳日期時沿用交易日，不補造時刻                                                   |
| `balAmt`                                                | 交易後餘額，納入交易識別                                                                                   |
| `userMemo`、`memo1`                                     | 交易說明；可編輯備註不納入識別                                                                             |
| `acctId`                                                | 對方帳號，不作本人的帳戶識別，也不保存於 raw                                                               |
| 明細 `sys: ESB, code: 9201`                             | 官方明細模組的明確無交易結果；其他系統同碼、通用 `8888`、矛盾明細或驗證要求均不能作空交易                  |

## 行為與限制

- 帳戶識別包含完整帳戶的雜湊與幣別，同帳戶不同幣別不合併，既有 TWD 識別不變。
- 餘額取同次初始化，與交易是否存在無關；零餘額與近期無交易仍保留。
- 金額不截斷或強制兩位小數，但共用 JS number／SQLite 不是任意精度十進位；拒絕超過安全範圍的值，無 schema migration。
- 正常入口新增近三個日曆月外幣交易查詢；每月獨立讀取完整 `detailList`。公開程式未見 server 分頁，未猜測下一頁端點。真實大筆數及銀行端截斷尚待驗證。
- 交易識別含帳戶幣別、日期、方向金額、交易後餘額與同組出現次序；可編輯備註不影響身分。完全相同列保留多筆，重疊月份去重；銀行更正日期／金額／餘額可能改變識別，仍待核對。
- 部分帳戶查詢或解析失敗則整次金融資料不提交、不推進 cursor，不把未知格式當作空帳戶。
- 新外幣正規化 `raw` 只留末碼與幣別；對方帳號不保存。未新增原始 payload 日誌。

## 實測狀態

2026-10-15，本機唯讀檢查已確認全部回傳外幣活存帳戶／幣別可解析餘額，包含近期沒有交易的情況。獨立測試站只查外幣活存餘額與限定範圍 TWD 信用卡，不查存款交易；使用者確認外幣餘額可讀取，後續卡名與交易可見。

外幣交易只有有限單月本機非空解析成功，尚未完成測試站寫入、逐筆金額／方向／日期、真實多頁或長期重複同步驗收。原幣餘額也尚未逐幣別宣告與銀行畫面完全一致。保持草稿，不能宣稱 #269 已全面完成。

合成測試覆蓋同帳戶多幣別、零餘額、空帳戶、部分失敗、小數、非空交易、月份重疊、同額多筆與重複同步。測試 fixture 全為合成帳戶、金額及交易，不使用帳務截圖。

## 本機與獨立測試

本機 `node scripts/inspect-ctbc-overview.mjs --balances-only` 僅查全部外幣活存餘額；其他交易檢查模式須先明確確認範圍。由本人輸入憑證並完成 App 核准，不讀取正式資料庫，不保存原始回應，只輸出白名單結構及固定狀態。

[獨立測試部署](ctbc-balance-test-deployment.md)使用新 Worker／D1／Queue／Access 與獨立金鑰；實際網址、資源 ID、憑證及含帳務截圖不公開。測試 D1 保存正規化金融資料，不能把「銀行端唯讀」誤認為「完全不保存資料」。
