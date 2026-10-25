// index.html 的 inline script 在 app 載入前用同一套規則先套主題，改這裡時要一起改。
export const THEME_STORAGE_KEY = "taiwan-fin-hub-theme";
export const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";
export const THEME_COLORS = { light: "#f8fafc", dark: "#111827" } as const;

export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];
export type ResolvedTheme = keyof typeof THEME_COLORS;

export function parseThemePreference(value: string | null): ThemePreference {
  return themePreferences.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function applyResolvedTheme(document: Document, theme: ResolvedTheme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[theme]);
}
