class MemoryCallbackStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key, callback) {
    queueMicrotask(() => {
      const value = this.values.get(key) ?? null;
      callback(null, value);
    });
  }

  setItem(key, value, callback) {
    this.values.set(key, value);
    queueMicrotask(() => callback(null, true));
  }

  removeItem(key, callback) {
    this.values.delete(key);
    queueMicrotask(() => callback(null, true));
  }
}

export class PreviewWebApp {
  constructor() {
    this.DeviceStorage = new MemoryCallbackStorage();
    this.SecureStorage = new MemoryCallbackStorage();
    this.events = new Map();
    this.colorScheme = "light";
  }

  isVersionAtLeast(version) {
    return version === "9.0";
  }

  onEvent(name, handler) {
    const handlers = this.events.get(name) ?? new Set();
    handlers.add(handler);
    this.events.set(name, handlers);
  }

  offEvent(name, handler) {
    this.events.get(name)?.delete(handler);
  }

  emit(name) {
    for (const handler of this.events.get(name) ?? []) handler();
  }

  ready() {}

  expand() {}

  setHeaderColor() {}

  setBackgroundColor() {}
}

export function isPreviewLocation(location = globalThis.location) {
  const hostname = location?.hostname ?? "";
  const explicitlyEnabled = new URLSearchParams(location?.search ?? "").get("preview") === "1";
  return explicitlyEnabled || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
