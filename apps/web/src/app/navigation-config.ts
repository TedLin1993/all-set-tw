import { BarChart3, FileText, History, Settings, Wallet } from "@lucide/svelte";
import type { Component } from "svelte";
import type { DetailView, MobileSettingsView, PrimaryView } from "./types";

export interface NavigationItem {
  view: PrimaryView;
  label: string;
  shortLabel: string;
  description: string;
  icon: Component;
}

export const navItems: NavigationItem[] = [
  {
    view: "overview",
    label: "總覽",
    shortLabel: "總覽",
    description: "淨資產、同步健康度與近期財務活動。",
    icon: BarChart3,
  },
  {
    view: "assets",
    label: "資產",
    shortLabel: "資產",
    description: "銀行、信用卡、投資與其他資產集中管理。",
    icon: Wallet,
  },
  {
    view: "activity",
    label: "活動",
    shortLabel: "活動",
    description: "銀行、刷卡、投資與發票的統一時間軸。",
    icon: History,
  },
  {
    view: "invoices",
    label: "發票",
    shortLabel: "發票",
    description: "搜尋電子發票、商家與品項明細。",
    icon: FileText,
  },
  {
    view: "settings",
    label: "設定",
    shortLabel: "設定",
    description: "管理資料來源、同步排程、匯率與交易分類。",
    icon: Settings,
  },
];

export const mobilePrimaryViews: PrimaryView[] = [
  "overview",
  "assets",
  "activity",
];

export const detailLabels: Record<
  DetailView,
  { label: string; description: string }
> = {
  bank: { label: "銀行帳戶", description: "帳戶餘額、現金流與交易分類。" },
  cards: { label: "信用卡", description: "信用卡帳戶、帳單與刷卡紀錄。" },
  investments: { label: "投資", description: "投資持倉與交易紀錄。" },
  "manual-assets": {
    label: "其他資產",
    description: "保險、不動產、交通工具與估值紀錄。",
  },
};

export const mobileSettingsLabels: Record<
  MobileSettingsView,
  { label: string; description: string }
> = {
  "data-sources": {
    label: "資料來源與連接器",
    description: "管理來源狀態、憑證、自動同步與重新驗證。",
  },
  "sync-notifications": {
    label: "同步與通知",
    description: "管理預設同步排程、推播與同步狀態通知。",
  },
  "exchange-rates": {
    label: "匯率",
    description: "查看資產換算使用的參考匯率。",
  },
  "classification-rules": {
    label: "分類規則",
    description: "讓銀行交易依條件自動分類。",
  },
};
