/** 總覽摘要的 API 契約。 */
export interface Summary {
  invoiceCount: number;
  investmentCount: number;
  totalInvestmentValue: number;
  bankAccountCount: number;
  totalBankBalance: number;
}
