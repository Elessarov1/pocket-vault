const LANGUAGE_STORAGE_KEY = "pocket-vault-language";
const SUPPORTED_LANGUAGES = new Set(["ru", "en"]);

const ENGLISH_CATALOG_URL = new URL("../locales/en.json", import.meta.url);
const ENGLISH = new Map();
const RUSSIAN = new Map();
let catalogPromise = null;
let currentLanguage = "ru";

export async function loadEnglishCatalog(fetcher = globalThis.fetch) {
  if (ENGLISH.size > 0) return;
  if (typeof fetcher !== "function") throw new Error("English catalog loader is unavailable");

  catalogPromise ??= (async () => {
    const response = await fetcher(ENGLISH_CATALOG_URL);
    if (!response?.ok) throw new Error(`English catalog request failed: ${response?.status ?? "unknown"}`);
    const catalog = await response.json();
    if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") {
      throw new TypeError("English catalog must be an object");
    }
    for (const [russian, english] of Object.entries(catalog)) {
      if (typeof english !== "string") throw new TypeError("English translation must be a string");
      ENGLISH.set(russian, english);
      RUSSIAN.set(english, russian);
    }
  })();

  try {
    await catalogPromise;
  } catch (error) {
    catalogPromise = null;
    throw error;
  }
}

export async function initializeLanguage(root = globalThis) {
  await loadEnglishCatalog(root.fetch?.bind(root) ?? globalThis.fetch?.bind(globalThis));
  currentLanguage = resolvePreferredLanguage(root);
  applyDocumentLanguage(root.document);
  translateRoot(root.document?.body);
  return currentLanguage;
}

export function resolvePreferredLanguage(root = globalThis) {
  const stored = readStoredLanguage(root.localStorage);
  if (stored) return stored;
  const telegramLanguage = root.Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  const browserLanguage = root.navigator?.language;
  return normalizeLanguage(telegramLanguage ?? browserLanguage ?? "ru");
}

export function setLanguage(language, { persist = true, root = globalThis } = {}) {
  currentLanguage = normalizeLanguage(language);
  if (persist) writeStoredLanguage(root.localStorage, currentLanguage);
  applyDocumentLanguage(root.document);
  translateRoot(root.document?.body);
  return currentLanguage;
}

export function toggleLanguage(options) {
  return setLanguage(currentLanguage === "ru" ? "en" : "ru", options);
}

export function getLanguage() {
  return currentLanguage;
}

export function getLocale() {
  return currentLanguage === "en" ? "en-US" : "ru-RU";
}

export function t(russianText) {
  return currentLanguage === "en" ? ENGLISH.get(russianText) ?? russianText : russianText;
}

export function hasEnglishTranslation(russianText) {
  return ENGLISH.has(russianText);
}

export function translateRoot(root) {
  if (!root) return;
  const document = root.ownerDocument ?? root;
  const walker = document.createTreeWalker(root, globalThis.NodeFilter?.SHOW_TEXT ?? 4);
  let node = walker.nextNode();
  while (node) {
    translateTextNode(node);
    node = walker.nextNode();
  }

  const elements = root.querySelectorAll?.("[placeholder], [aria-label], [title]") ?? [];
  for (const element of elements) {
    for (const attribute of ["placeholder", "aria-label", "title"]) {
      if (element.hasAttribute(attribute)) {
        element.setAttribute(attribute, translateValue(element.getAttribute(attribute)));
      }
    }
  }
  updateLanguageButtons(root);
}

export function updateLanguageButtons(root = globalThis.document) {
  const buttons = root?.querySelectorAll?.("[data-language-toggle]") ?? [];
  for (const button of buttons) {
    button.textContent = currentLanguage === "ru" ? "EN" : "RU";
    button.setAttribute(
      "aria-label",
      currentLanguage === "ru" ? "Switch to English" : "Переключить на русский",
    );
  }
  const values = root?.querySelectorAll?.("[data-current-language]") ?? [];
  for (const value of values) value.textContent = currentLanguage === "ru" ? "Русский" : "English";
}

function translateTextNode(node) {
  const value = node.nodeValue;
  const match = value?.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!match || !match[2]) return;
  const translated = translateValue(match[2]);
  if (translated !== match[2]) node.nodeValue = `${match[1]}${translated}${match[3]}`;
}

function translateValue(value) {
  const russian = ENGLISH.has(value) ? value : RUSSIAN.get(value);
  if (!russian) return value;
  return currentLanguage === "en" ? ENGLISH.get(russian) : russian;
}

function normalizeLanguage(language) {
  const normalized = String(language).toLocaleLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LANGUAGES.has(normalized) ? normalized : "en";
}

function readStoredLanguage(storage) {
  try {
    const value = storage?.getItem(LANGUAGE_STORAGE_KEY);
    return SUPPORTED_LANGUAGES.has(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredLanguage(storage, language) {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Language preference is non-critical and may be blocked by the WebView.
  }
}

function applyDocumentLanguage(document = globalThis.document) {
  if (!document?.documentElement) return;
  document.documentElement.lang = currentLanguage;
  const title = document.querySelector("title");
  if (title) title.textContent = translateValue(title.textContent);
}
