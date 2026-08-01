export const MINIMUM_BOT_API_VERSION = "9.0";

export class UnsupportedTelegramError extends Error {
  constructor(message = "Telegram Bot API 9.0 storage APIs are unavailable") {
    super(message);
    this.name = "UnsupportedTelegramError";
    this.code = "unsupported_telegram";
  }
}

export function resolveTelegramWebApp(root = globalThis) {
  const webApp = root?.Telegram?.WebApp;
  if (
    !webApp ||
    typeof webApp.isVersionAtLeast !== "function" ||
    !webApp.isVersionAtLeast(MINIMUM_BOT_API_VERSION)
  ) {
    throw new UnsupportedTelegramError();
  }

  assertMethods(webApp.DeviceStorage, ["getItem", "setItem", "removeItem"]);
  assertMethods(webApp.SecureStorage, ["getItem", "setItem"]);
  return webApp;
}

export function bindDeactivated(webApp, handler) {
  if (typeof webApp?.onEvent !== "function" || typeof webApp?.offEvent !== "function") {
    throw new UnsupportedTelegramError("Telegram lifecycle events are unavailable");
  }
  webApp.onEvent("deactivated", handler);
  return () => webApp.offEvent("deactivated", handler);
}

function assertMethods(value, methods) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new UnsupportedTelegramError();
  }
}
