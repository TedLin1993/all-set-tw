import {
  applyResolvedTheme,
  DARK_COLOR_SCHEME_QUERY,
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";

export const themeState = $state<{ preference: ThemePreference }>({
  preference: "system",
});

function readStoredPreference() {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function applyCurrentTheme() {
  applyResolvedTheme(
    document,
    resolveTheme(
      themeState.preference,
      window.matchMedia(DARK_COLOR_SCHEME_QUERY).matches,
    ),
  );
}

export function initTheme() {
  themeState.preference = readStoredPreference();
  applyCurrentTheme();
  // 「跟隨系統」時，系統切換深淺色要即時反映。
  window
    .matchMedia(DARK_COLOR_SCHEME_QUERY)
    .addEventListener("change", applyCurrentTheme);
}

export function setThemePreference(preference: ThemePreference) {
  themeState.preference = preference;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 無法寫入（例如私密瀏覽）時仍套用到本次開啟的頁面。
  }
  applyCurrentTheme();
}
