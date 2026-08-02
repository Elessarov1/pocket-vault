class MockCallbackStorage {
  constructor(kind, calls) {
    this.kind = kind;
    this.calls = calls;
    this.values = new Map();
    this.restorableValues = new Map();
    this.failures = new Map();
    this.setFailures = new Map();
    this.skipCallbacks = new Set();
  }

  failNext(method, error = "FAILED") {
    this.failures.set(method, error);
  }

  skipNextCallback(method) {
    this.skipCallbacks.add(method);
  }

  failNextSetFor(key, error = "FAILED") {
    this.setFailures.set(key, error);
  }

  callback(method, callback, successValues) {
    if (this.skipCallbacks.delete(method)) return;
    const error = this.failures.get(method);
    this.failures.delete(method);
    queueMicrotask(() => {
      if (error !== undefined) callback(error);
      else callback(null, ...successValues);
    });
  }
}

export class MockDeviceStorage extends MockCallbackStorage {
  constructor(calls = []) {
    super("device", calls);
  }

  getItem(key, callback) {
    this.calls.push(`device.get:${key}`);
    this.callback("getItem", callback, [this.values.get(key) ?? null]);
    return this;
  }

  setItem(key, value, callback) {
    this.calls.push(`device.set:${key}`);
    const targetedError = this.setFailures.get(key);
    if (targetedError !== undefined) {
      this.setFailures.delete(key);
      queueMicrotask(() => callback(targetedError));
      return this;
    }
    if (!this.failures.has("setItem")) this.values.set(key, value);
    this.callback("setItem", callback, [true]);
    return this;
  }

  removeItem(key, callback) {
    this.calls.push(`device.remove:${key}`);
    if (!this.failures.has("removeItem")) this.values.delete(key);
    this.callback("removeItem", callback, [true]);
    return this;
  }
}

export class MockSecureStorage extends MockCallbackStorage {
  constructor(calls = []) {
    super("secure", calls);
  }

  getItem(key, callback) {
    this.calls.push(`secure.get:${key}`);
    this.callback("getItem", callback, [
      this.values.get(key) ?? null,
      this.restorableValues.has(key),
    ]);
    return this;
  }

  setItem(key, value, callback) {
    this.calls.push(`secure.set:${key}`);
    if (!this.failures.has("setItem")) {
      this.values.set(key, value);
      this.restorableValues.delete(key);
    }
    this.callback("setItem", callback, [true]);
    return this;
  }

  restoreItem(key, callback) {
    this.calls.push(`secure.restore:${key}`);
    const value = this.restorableValues.get(key) ?? null;
    if (!this.failures.has("restoreItem") && value !== null) {
      this.restorableValues.delete(key);
      this.values.set(key, value);
    }
    this.callback("restoreItem", callback, [value]);
    return this;
  }

  removeItem(key, callback) {
    this.calls.push(`secure.remove:${key}`);
    if (!this.failures.has("removeItem")) {
      this.values.delete(key);
      this.restorableValues.delete(key);
    }
    this.callback("removeItem", callback, [true]);
    return this;
  }
}

export class MockWebApp {
  constructor({ versionSupported = true } = {}) {
    this.calls = [];
    this.versionSupported = versionSupported;
    this.DeviceStorage = new MockDeviceStorage(this.calls);
    this.SecureStorage = new MockSecureStorage(this.calls);
    this.handlers = new Map();
  }

  isVersionAtLeast(version) {
    this.calls.push(`version:${version}`);
    return this.versionSupported;
  }

  onEvent(name, handler) {
    this.handlers.set(name, handler);
  }

  offEvent(name, handler) {
    if (this.handlers.get(name) === handler) this.handlers.delete(name);
  }

  emit(name) {
    this.handlers.get(name)?.();
  }
}
