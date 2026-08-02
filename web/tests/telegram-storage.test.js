import assert from "node:assert/strict";
import test from "node:test";

import { TelegramDeviceStorage, TelegramSecureStorage } from "../src/storage.js";
import { resolveTelegramWebApp, UnsupportedTelegramError } from "../src/telegram.js";
import { MockWebApp } from "./helpers/mock-telegram.js";

test("capability check requires Bot API 9.0 and DeviceStorage", () => {
  const supported = new MockWebApp();
  assert.equal(resolveTelegramWebApp({ Telegram: { WebApp: supported } }), supported);
  assert.throws(
    () => resolveTelegramWebApp({ Telegram: { WebApp: new MockWebApp({ versionSupported: false }) } }),
    UnsupportedTelegramError,
  );
  assert.throws(() => resolveTelegramWebApp({}), UnsupportedTelegramError);
});

test("device adapter verifies writes and normalizes callback errors", async () => {
  const webApp = new MockWebApp();
  const storage = new TelegramDeviceStorage(webApp.DeviceStorage);
  await storage.setVerified("vault_meta_v1", "ciphertext");
  assert.equal(await storage.get("vault_meta_v1"), "ciphertext");

  webApp.DeviceStorage.failNext("getItem");
  await assert.rejects(storage.get("vault_meta_v1"), { code: "callback_error" });
});

test("adapter rejects a callback that never arrives", async () => {
  const webApp = new MockWebApp();
  webApp.DeviceStorage.skipNextCallback("getItem");
  const storage = new TelegramDeviceStorage(webApp.DeviceStorage, { timeoutMs: 5 });
  await assert.rejects(storage.get("key"), { code: "timeout" });
});

test("mutations use verified readback when optional callbacks never arrive", async () => {
  const webApp = new MockWebApp();
  const device = new TelegramDeviceStorage(webApp.DeviceStorage);

  webApp.DeviceStorage.skipNextCallback("setItem");
  await device.setVerified("vault_meta_v1", "ciphertext");
  assert.equal(await device.get("vault_meta_v1"), "ciphertext");

  webApp.DeviceStorage.skipNextCallback("removeItem");
  await device.removeVerified("vault_meta_v1");
  assert.equal(await device.get("vault_meta_v1"), null);
});

test("secure adapter stores a remembered master password with verified readback", async () => {
  const webApp = new MockWebApp();
  const secure = new TelegramSecureStorage(webApp.SecureStorage);

  await secure.setVerified("master_password_cache_v1", "a long master phrase");
  assert.equal(await secure.get("master_password_cache_v1"), "a long master phrase");
  await secure.removeVerified("master_password_cache_v1");
  assert.equal(await secure.get("master_password_cache_v1"), null);
});

test("secure adapter restores a recoverable value reported by Telegram", async () => {
  const webApp = new MockWebApp();
  const secure = new TelegramSecureStorage(webApp.SecureStorage);
  webApp.SecureStorage.restorableValues.set("master_password_cache_v1", "cached value");

  assert.equal(await secure.get("master_password_cache_v1"), "cached value");
  assert.equal(
    webApp.calls.includes("secure.restore:master_password_cache_v1"),
    true,
  );
});

test("missing SecureStorage is reported without making DeviceStorage unsupported", async () => {
  const secure = new TelegramSecureStorage(undefined);
  await assert.rejects(secure.get("master_password_cache_v1"), { code: "unsupported_storage" });
});
