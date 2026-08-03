import {
  getLanguage,
  initializeLanguage,
  setLanguage,
  toggleLanguage,
} from "./src/i18n.js";
import {
  getTheme,
  initializeTheme,
  setTheme,
  toggleTheme,
  updateThemeControls,
} from "./src/theme.js";

const MESSAGE_TYPE = "pocket-vault-review";
const frame = document.querySelector("#review-frame");
const screenPicker = document.querySelector("#screen-picker");
let frameReady = false;
let selectedScreen = "onboarding";

function postToPreview(action, value) {
  if (!frameReady || !frame?.contentWindow) return;
  frame.contentWindow.postMessage({ type: MESSAGE_TYPE, action, value }, location.origin);
}

function synchronizePreview() {
  postToPreview("screen", selectedScreen);
  postToPreview("theme", getTheme());
  postToPreview("language", getLanguage());
}

function selectScreen(screen, { notify = true } = {}) {
  selectedScreen = screen;
  if (screenPicker) screenPicker.value = screen;
  document.querySelectorAll("[data-screen]").forEach((button) => {
    const active = button.dataset.screen === screen;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  if (notify) postToPreview("screen", screen);
}

window.addEventListener("message", (event) => {
  if (
    event.origin !== location.origin
    || event.source !== frame?.contentWindow
    || event.data?.type !== MESSAGE_TYPE
  ) {
    return;
  }
  if (event.data.action === "ready") {
    frameReady = true;
    synchronizePreview();
  } else if (event.data.action === "screen") {
    selectScreen(event.data.value, { notify: false });
  } else if (event.data.action === "theme") {
    setTheme(event.data.value);
  } else if (event.data.action === "language") {
    setLanguage(event.data.value);
    updateThemeControls(document);
  }
});

frame?.addEventListener("load", () => {
  frame?.contentWindow?.postMessage(
    { type: MESSAGE_TYPE, action: "ping" },
    location.origin,
  );
});

for (const button of document.querySelectorAll("[data-screen]")) {
  button.addEventListener("click", () => selectScreen(button.dataset.screen));
}
screenPicker?.addEventListener("change", () => selectScreen(screenPicker.value));

for (const button of document.querySelectorAll("[data-theme-choice]")) {
  button.addEventListener("click", () => {
    const theme = setTheme(button.dataset.themeChoice);
    postToPreview("theme", theme);
  });
}
for (const button of document.querySelectorAll("[data-theme-toggle]")) {
  button.addEventListener("click", () => {
    const theme = toggleTheme();
    postToPreview("theme", theme);
  });
}
for (const button of document.querySelectorAll("[data-language-toggle]")) {
  button.addEventListener("click", () => {
    const language = toggleLanguage();
    updateThemeControls(document);
    postToPreview("language", language);
  });
}

try {
  await initializeLanguage(globalThis);
} catch (error) {
  console.error("Pocket Vault review translations failed to load", error);
}
initializeTheme(globalThis);
selectScreen(selectedScreen, { notify: false });
