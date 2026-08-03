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
  assert.equal(await storage.getExisting("vault_meta_v1"), "ciphertext");

  webApp.DeviceStorage.failNext("getItem");
  await assert.rejects(storage.getExisting("vault_meta_v1"), { code: "callback_error" });
});

test("adapter rejects a callback that never arrives", async () => {
  const webApp = new MockWebApp();
  webApp.DeviceStorage.skipNextCallback("getItem");
  const storage = new TelegramDeviceStorage(webApp.DeviceStorage, { timeoutMs: 5 });
  await assert.rejects(storage.getExisting("key"), { code: "timeout" });
});

test("mutations use verified readback when optional callbacks never arrive", async () => {
  const webApp = new MockWebApp();
  const device = new TelegramDeviceStorage(webApp.DeviceStorage);

  webApp.DeviceStorage.skipNextCallback("setItem");
  await device.setVerified("vault_meta_v1", "ciphertext");
  assert.equal(await device.getExisting("vault_meta_v1"), "ciphertext");

  webApp.DeviceStorage.skipNextCallback("removeItem");
  await device.removeVerified("vault_meta_v1");
  assert.equal(await device.getExisting("vault_meta_v1"), null);
});

test("secure adapter verifies writes and removals without implicit restore", async () => {
  const webApp = new MockWebApp();
  const secure = new TelegramSecureStorage(webApp.SecureStorage);

  await secure.setVerified("quick_unlock_key", "random key");
  assert.equal(await secure.getExisting("quick_unlock_key"), "random key");
  await secure.removeVerified("quick_unlock_key");
  assert.equal(await secure.getExisting("quick_unlock_key"), null);
  assert.equal(webApp.calls.some((call) => call.startsWith("secure.restore:")), false);
});

test("recoverable secure values are restored only by an explicit operation", async () => {
  const webApp = new MockWebApp();
  const secure = new TelegramSecureStorage(webApp.SecureStorage);
  webApp.SecureStorage.restorableValues.set("quick_unlock_key", "cached value");

  assert.equal(await secure.getExisting("quick_unlock_key"), null);
  assert.equal(webApp.calls.some((call) => call.startsWith("secure.restore:")), false);
  assert.equal(await secure.restoreExplicitly("quick_unlock_key"), "cached value");
  assert.equal(
    webApp.calls.includes("secure.restore:quick_unlock_key"),
    true,
  );
});

test("removing a recoverable secure value never restores it during verification", async () => {
  const webApp = new MockWebApp();
  const secure = new TelegramSecureStorage(webApp.SecureStorage);
  webApp.SecureStorage.restorableValues.set("master_password_cache_v1", "legacy password");

  await secure.removeVerified("master_password_cache_v1");

  assert.equal(webApp.SecureStorage.restorableValues.has("master_password_cache_v1"), false);
  assert.equal(webApp.calls.some((call) => call.startsWith("secure.restore:")), false);
});

test("missing SecureStorage is reported without making DeviceStorage unsupported", async () => {
  const secure = new TelegramSecureStorage(undefined);
  await assert.rejects(secure.getExisting("quick_unlock_key"), { code: "unsupported_storage" });
});
