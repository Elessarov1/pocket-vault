import { t } from "./i18n.js";

const THEME_STORAGE_KEY = "pocket-vault-theme";
const SUPPORTED_THEMES = new Set(["light", "dark"]);
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

let activeRoot = globalThis;
let currentTheme = "light";
let currentPreference = "system";
let systemThemeQuery = null;
let systemThemeListener = null;

export function initializeTheme(root = globalThis) {
  detachSystemThemeListener();
  activeRoot = root;

  const storedTheme = readStoredTheme(root);
  currentPreference = storedTheme ? "manual" : "system";
  systemThemeQuery = getSystemThemeQuery(root);
  currentTheme = storedTheme ?? themeFromQuery(systemThemeQuery);

  systemThemeListener = (event) => {
    if (currentPreference !== "system") return;
    currentTheme = event.matches ? "dark" : "light";
    applyTheme(activeRoot);
  };
  if (systemThemeQuery?.addEventListener) {
    systemThemeQuery.addEventListener("change", systemThemeListener);
  } else {
    systemThemeQuery?.addListener?.(systemThemeListener);
  }

  applyTheme(root);
  return currentTheme;
}

export function resolvePreferredTheme(root = globalThis) {
  return readStoredTheme(root) ?? themeFromQuery(getSystemThemeQuery(root));
}

export function setTheme(theme, { persist = true, root = activeRoot } = {}) {
  if (!SUPPORTED_THEMES.has(theme)) return currentTheme;
  activeRoot = root;
  currentTheme = theme;
  if (persist) {
    currentPreference = "manual";
    writeStoredTheme(root, theme);
  }
  applyTheme(root);
  return currentTheme;
}

export function toggleTheme(options) {
  return setTheme(currentTheme === "dark" ? "light" : "dark", options);
}

export function getTheme() {
  return currentTheme;
}

export function getThemePreference() {
  return currentPreference;
}

export function updateThemeControls(root = activeRoot.document) {
  const choices = root?.querySelectorAll?.("[data-theme-choice]") ?? [];
  for (const button of choices) {
    const active = button.dataset.themeChoice === currentTheme;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  const targetLabel = currentTheme === "dark"
    ? t("Переключить на светлую тему")
    : t("Переключить на тёмную тему");
  const toggles = root?.querySelectorAll?.("[data-theme-toggle]") ?? [];
  for (const button of toggles) {
    button.dataset.themeCurrent = currentTheme;
    button.setAttribute("aria-label", targetLabel);
    button.setAttribute("title", targetLabel);
    button.setAttribute("aria-pressed", String(currentTheme === "dark"));
  }

  const effectiveTheme = currentTheme === "dark" ? "Тёмная" : "Светлая";
  const currentLabel = currentPreference === "system"
    ? t(currentTheme === "dark" ? "Системная: тёмная" : "Системная: светлая")
    : t(effectiveTheme);
  const values = root?.querySelectorAll?.("[data-current-theme]") ?? [];
  for (const value of values) value.textContent = currentLabel;
}

function applyTheme(root) {
  const document = root?.document;
  if (document?.documentElement) document.documentElement.dataset.theme = currentTheme;
  const themeColor = document?.querySelector?.("meta[name='theme-color']");
  if (themeColor) themeColor.content = currentTheme === "dark" ? "#171c19" : "#f2f0e9";
  updateThemeControls(document);
}

function getSystemThemeQuery(root) {
  try {
    return root?.matchMedia?.(SYSTEM_THEME_QUERY) ?? null;
  } catch {
    return null;
  }
}

function themeFromQuery(query) {
  return query?.matches ? "dark" : "light";
}

function readStoredTheme(root) {
  try {
    const value = root?.localStorage?.getItem(THEME_STORAGE_KEY);
    return SUPPORTED_THEMES.has(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(root, theme) {
  try {
    root?.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme persistence is non-critical and may be blocked by the WebView.
  }
}

function detachSystemThemeListener() {
  if (!systemThemeQuery || !systemThemeListener) return;
  if (systemThemeQuery.removeEventListener) {
    systemThemeQuery.removeEventListener("change", systemThemeListener);
  } else {
    systemThemeQuery.removeListener?.(systemThemeListener);
  }
}
