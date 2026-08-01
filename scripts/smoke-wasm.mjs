import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { VaultAppController } from "../web/src/app-controller.js";
import { PreviewWebApp } from "../web/src/preview-runtime.js";
import { TelegramDeviceStorage, TelegramSecureStorage } from "../web/src/storage.js";
import { VaultPersistence } from "../web/src/vault-persistence.js";
import { initSync, VaultSession, generateDeviceSecretEnvelope, validateDeviceSecretEnvelope } from "../web/pkg/vault_wasm.js";

const bytes = await readFile(new URL("../web/pkg/vault_wasm_bg.wasm", import.meta.url));
initSync({ module: bytes });

const webApp = new PreviewWebApp();
const persistence = new VaultPersistence({
  deviceStorage: new TelegramDeviceStorage(webApp.DeviceStorage),
  secureStorage: new TelegramSecureStorage(webApp.SecureStorage),
  wasm: { VaultSession, generateDeviceSecretEnvelope, validateDeviceSecretEnvelope },
});
let timestamp = 1_800_000_000_000;
const controller = new VaultAppController({ persistence, now: () => timestamp++ });

await controller.initialize();
assert.equal(controller.snapshot().screen, "onboarding");
await controller.create("следуй-за-белым-кроликом-домой");
controller.beginEdit();
await controller.saveEntry({ title: "Почта", secret: "M0cha-Pine-47!", description: "Основной аккаунт" });

const [{ id }] = controller.snapshot().entries;
const details = controller.openEntry(id);
assert.equal(details.description, "Основной аккаунт");
assert.equal(JSON.stringify(details).includes("M0cha-Pine-47!"), false);
assert.equal(controller.getSelectedSecret(), "M0cha-Pine-47!");

const editable = controller.beginEdit(id);
assert.equal(editable.secret, "M0cha-Pine-47!");
await controller.saveEntry({ title: "Почта", secret: "новый-секрет", description: "Обновлено" });

controller.lock();
await controller.unlock("следуй-за-белым-кроликом-домой");
controller.openEntry(id);
assert.equal(controller.getSelectedSecret(), "новый-секрет");
await controller.deleteSelected();
assert.equal(controller.snapshot().entries.length, 0);
await controller.destroy();
assert.equal((await persistence.inspectState()).state, "uninitialized");

console.log("WASM smoke test passed: create, save, update, lock, reopen, delete, destroy");
