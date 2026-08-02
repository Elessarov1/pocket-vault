import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getLanguage,
  getLocale,
  hasEnglishTranslation,
  resolvePreferredLanguage,
  setLanguage,
  t,
  toggleLanguage,
} from "../src/i18n.js";

function storage(value = null) {
  return {
    value,
    getItem() {
      return this.value;
    },
    setItem(_key, next) {
      this.value = next;
    },
  };
}

test("stored preference wins over Telegram and browser languages", () => {
  assert.equal(resolvePreferredLanguage({
    localStorage: storage("ru"),
    Telegram: { WebApp: { initDataUnsafe: { user: { language_code: "en" } } } },
    navigator: { language: "en-US" },
  }), "ru");
});

test("Telegram language is used when no preference is stored", () => {
  assert.equal(resolvePreferredLanguage({
    localStorage: storage(),
    Telegram: { WebApp: { initDataUnsafe: { user: { language_code: "en-US" } } } },
    navigator: { language: "ru-RU" },
  }), "en");
});

test("translation and locale follow the selected language", () => {
  const localStorage = storage();
  setLanguage("en", { root: { localStorage } });
  assert.equal(getLanguage(), "en");
  assert.equal(getLocale(), "en-US");
  assert.equal(t("Хранилище"), "Vault");
  assert.equal(localStorage.value, "en");

  toggleLanguage({ persist: false, root: {} });
  assert.equal(getLanguage(), "ru");
  assert.equal(t("Хранилище"), "Хранилище");
});

test("every static Russian UI string has an English translation", async () => {
  const files = [
    new URL("../index.html", import.meta.url),
    new URL("../privacy.html", import.meta.url),
  ];
  const missing = new Set();

  for (const file of files) {
    const html = (await readFile(file, "utf8")).replace(/<svg[\s\S]*?<\/svg>/g, "");
    for (const match of html.matchAll(/>([^<>]+)</g)) collectRussian(match[1], missing);
    for (const match of html.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)) {
      collectRussian(match[1], missing);
    }
  }

  assert.deepEqual([...missing].sort(), []);
});

function collectRussian(value, missing) {
  const normalized = value.trim();
  if (/[А-Яа-яЁё]/.test(normalized) && !hasEnglishTranslation(normalized)) {
    missing.add(normalized);
  }
}
