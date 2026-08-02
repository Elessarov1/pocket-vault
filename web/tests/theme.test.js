import assert from "node:assert/strict";
import test from "node:test";

import {
  getTheme,
  getThemePreference,
  initializeTheme,
  resolvePreferredTheme,
  setTheme,
  toggleTheme,
} from "../src/theme.js";

function createRoot({ stored = null, systemDark = false } = {}) {
  const listeners = new Set();
  const storage = {
    value: stored,
    getItem() {
      return this.value;
    },
    setItem(_key, value) {
      this.value = value;
    },
  };
  const media = {
    matches: systemDark,
    addEventListener(_event, listener) {
      listeners.add(listener);
    },
    removeEventListener(_event, listener) {
      listeners.delete(listener);
    },
    emit(matches) {
      this.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
  };
  const meta = { content: "" };
  const document = {
    documentElement: { dataset: {} },
    querySelector(selector) {
      return selector === "meta[name='theme-color']" ? meta : null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return {
    document,
    localStorage: storage,
    matchMedia: () => media,
    media,
    meta,
  };
}

test("stored theme overrides the system theme", () => {
  const root = createRoot({ stored: "light", systemDark: true });
  assert.equal(resolvePreferredTheme(root), "light");
  assert.equal(initializeTheme(root), "light");
  assert.equal(getThemePreference(), "manual");
  assert.equal(root.document.documentElement.dataset.theme, "light");
  assert.equal(root.meta.content, "#f2f0e9");
});

test("system theme is selected and followed without a manual preference", () => {
  const root = createRoot({ systemDark: true });
  assert.equal(initializeTheme(root), "dark");
  assert.equal(getThemePreference(), "system");

  root.media.emit(false);
  assert.equal(getTheme(), "light");
  assert.equal(root.document.documentElement.dataset.theme, "light");
});

test("one-click toggle persists a manual override", () => {
  const root = createRoot({ systemDark: false });
  initializeTheme(root);
  assert.equal(toggleTheme({ root }), "dark");
  assert.equal(root.localStorage.value, "dark");
  assert.equal(getThemePreference(), "manual");

  root.media.emit(false);
  assert.equal(getTheme(), "dark");
  assert.equal(setTheme("light", { root }), "light");
});
