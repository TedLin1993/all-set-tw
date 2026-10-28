/** 台幣估值絕對值低於此金額的持倉視為小額：加密貨幣同步時不輸出，前端不列出但計入小計。 */
export const INVESTMENT_DUST_THRESHOLD_TWD = 10;

/**
 * 加密貨幣交易所本次同步沒有任何持倉時寫入的零值列 sourceId，避免「最新持倉」退回前一天；
 * 前端據此不列出這一列，改顯示「目前沒有持倉」。
 */
export const EMPTY_INVESTMENT_SOURCE_ID = "empty";
