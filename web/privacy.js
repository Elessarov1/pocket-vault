import { initializeLanguage, toggleLanguage } from "./src/i18n.js";
import { initializeTheme, toggleTheme } from "./src/theme.js";

initializeLanguage(globalThis);
initializeTheme(globalThis);

document.querySelector("[data-language-toggle]")?.addEventListener("click", () => {
  toggleLanguage();
});

document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  toggleTheme();
});
