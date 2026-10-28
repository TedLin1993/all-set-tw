export type PrimaryView = "overview" | "assets" | "activity" | "settings";

export type MobileSettingsView =
  | "data-sources"
  | "sync-notifications"
  | "exchange-rates"
  | "classification-rules"
  | "about";

export type View = PrimaryView | MobileSettingsView | "more";

export interface RuntimeInfo {
  demoMode: boolean;
}
