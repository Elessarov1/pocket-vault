import initWasm, * as wasm from "../pkg/vault_wasm.js";

import { TelegramDeviceStorage, TelegramSecureStorage } from "./storage.js";
import { PreviewWebApp } from "./preview-runtime.js";
import { resolveTelegramWebApp } from "./telegram.js";
import { VaultPersistence } from "./vault-persistence.js";

export async function initializeVaultRuntime(root = globalThis) {
  const webApp = resolveTelegramWebApp(root);
  await initWasm();

  return createRuntime(webApp, "telegram");
}

export async function initializePreviewRuntime() {
  await initWasm();
  return createRuntime(new PreviewWebApp(), "preview");
}

function createRuntime(webApp, mode) {
  const persistence = new VaultPersistence({
    deviceStorage: new TelegramDeviceStorage(webApp.DeviceStorage),
    secureStorage: webApp.SecureStorage
      ? new TelegramSecureStorage(webApp.SecureStorage)
      : null,
    wasm,
  });

  return { webApp, persistence, wasm, mode };
}
