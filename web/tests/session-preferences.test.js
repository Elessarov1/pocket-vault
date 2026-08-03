import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  SESSION_TIMEOUT_STORAGE_KEY,
  loadSessionTimeoutMinutes,
  normalizeSessionTimeoutMinutes,
  saveSessionTimeoutMinutes,
} from "../src/session-preferences.js";

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set(SESSION_TIMEOUT_STORAGE_KEY, initialValue);
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    values,
  };
}

test("session timeout defaults to five minutes and accepts presets or custom values", () => {
  assert.equal(loadSessionTimeoutMinutes(createStorage()), DEFAULT_SESSION_TIMEOUT_MINUTES);
  assert.equal(normalizeSessionTimeoutMinutes(5), 5);
  assert.equal(normalizeSessionTimeoutMinutes("10"), 10);
  assert.equal(normalizeSessionTimeoutMinutes(15), 15);
  assert.equal(normalizeSessionTimeoutMinutes(7), 7);
});

test("session timeout is persisted as a non-secret local preference", () => {
  const storage = createStorage();
  assert.equal(saveSessionTimeoutMinutes(12, storage), 12);
  assert.equal(storage.values.get(SESSION_TIMEOUT_STORAGE_KEY), "12");
  assert.equal(loadSessionTimeoutMinutes(storage), 12);
});

test("invalid or inaccessible preferences fall back safely", () => {
  assert.equal(loadSessionTimeoutMinutes(createStorage("0")), DEFAULT_SESSION_TIMEOUT_MINUTES);
  assert.equal(loadSessionTimeoutMinutes(createStorage("1441")), DEFAULT_SESSION_TIMEOUT_MINUTES);
  assert.throws(() => normalizeSessionTimeoutMinutes(2.5), RangeError);
  assert.equal(saveSessionTimeoutMinutes(1_440, createStorage()), 1_440);
  assert.throws(() => saveSessionTimeoutMinutes(1_441, createStorage()), RangeError);
  assert.equal(loadSessionTimeoutMinutes({ getItem: () => { throw new Error("blocked"); } }), 5);
});
