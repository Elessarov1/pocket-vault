import assert from "node:assert/strict";
import test from "node:test";

import { TelegramDeviceStorage, TelegramSecureStorage } from "../src/storage.js";
import { resolveTelegramWebApp, UnsupportedTelegramError } from "../src/telegram.js";
import { MockWebApp } from "./helpers/mock-telegram.js";

test("capability check requires Bot API 9.0 and both storage objects", () => {
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

test("secure adapter reports restorability without invoking restoreItem", async () => {
  const webApp = new MockWebApp();
  webApp.SecureStorage.restorable.add("device_secret_v1");
  const storage = new TelegramSecureStorage(webApp.SecureStorage);

  assert.deepEqual(await storage.get("device_secret_v1"), {
    value: null,
    canRestore: true,
  });
  assert.equal(webApp.calls.some((call) => call.startsWith("secure.restore:")), false);
});

test("adapter rejects a callback that never arrives", async () => {
  const webApp = new MockWebApp();
  webApp.DeviceStorage.skipNextCallback("getItem");
  const storage = new TelegramDeviceStorage(webApp.DeviceStorage, { timeoutMs: 5 });
  await assert.rejects(storage.get("key"), { code: "timeout" });
});
