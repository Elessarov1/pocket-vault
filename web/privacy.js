import { initializeLanguage, toggleLanguage } from "./src/i18n.js";

initializeLanguage(globalThis);

document.querySelector("[data-language-toggle]")?.addEventListener("click", () => {
  toggleLanguage();
});
