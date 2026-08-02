import { initializeLanguage, toggleLanguage } from "./src/i18n.js";
import { initializeTheme, toggleTheme } from "./src/theme.js";

async function boot() {
  try {
    await initializeLanguage(globalThis);
  } catch (error) {
    console.error("Pocket Vault translation catalog failed to load", error);
  }
  initializeTheme(globalThis);

  document.querySelector("[data-language-toggle]")?.addEventListener("click", toggleLanguage);
  document.querySelector("[data-theme-toggle]")?.addEventListener("click", toggleTheme);
}

void boot();
