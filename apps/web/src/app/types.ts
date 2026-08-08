export type PrimaryView =
  "overview" | "assets" | "activity" | "invoices" | "settings";

export type DetailView = "investments" | "manual-assets";

export type MobileSettingsView =
  | "data-sources"
  | "sync-notifications"
  | "exchange-rates"
  | "classification-rules";

export type View = PrimaryView | DetailView | MobileSettingsView | "more";

export interface RuntimeInfo {
  demoMode: boolean;
}
