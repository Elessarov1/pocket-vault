const DEFAULT_TIMEOUT_MS = 10_000;
const VERIFY_INTERVAL_MS = 50;

export class TelegramStorageError extends Error {
  constructor(code, operation, { nativeCode = null } = {}) {
    super(`${operation} failed`);
    this.name = "TelegramStorageError";
    this.code = code;
    this.operation = operation;
    this.nativeCode = nativeCode;
  }
}

class TelegramStorageAdapter {
  constructor(storage, kind, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.storage = storage;
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }

  async get(key) {
    validateKey(key);
    const [storedValue, canRestore] = await invoke(
      this.storage,
      "getItem",
      [key],
      this.timeoutMs,
      this.operation("getItem"),
    );
    const value = storedValue === null && canRestore ? await this.restore(key) : storedValue;
    if (value !== null && typeof value !== "string") {
      throw new TelegramStorageError("invalid_response", this.operation("getItem"));
    }
    return value;
  }

  async setVerified(key, value) {
    validateKey(key);
    validateValue(value);
    await mutateAndVerify({
      storage: this.storage,
      method: "setItem",
      args: [key, value],
      operation: this.operation("setItem"),
      timeoutMs: this.timeoutMs,
      unconfirmedCode: "write_not_confirmed",
      verify: async () => (await this.get(key)) === value,
    });
  }

  async removeVerified(key) {
    validateKey(key);
    await mutateAndVerify({
      storage: this.storage,
      method: "removeItem",
      args: [key],
      operation: this.operation("removeItem"),
      timeoutMs: this.timeoutMs,
      unconfirmedCode: "remove_not_confirmed",
      verify: async () => (await this.get(key)) === null,
    });
  }

  async restore(key) {
    if (this.kind !== "secure") return null;
    const [value] = await invoke(
      this.storage,
      "restoreItem",
      [key],
      this.timeoutMs,
      this.operation("restoreItem"),
    );
    return value;
  }

  operation(method) {
    return `${this.kind}.${method}`;
  }
}

export class TelegramDeviceStorage extends TelegramStorageAdapter {
  constructor(storage, options) {
    super(storage, "device", options);
  }

  async set(key, value) {
    await this.setVerified(key, value);
  }

  async remove(key) {
    await this.removeVerified(key);
  }
}

export class TelegramSecureStorage extends TelegramStorageAdapter {
  constructor(storage, options) {
    super(storage, "secure", options);
  }
}

function invoke(storage, method, args, timeoutMs, operation = method) {
  assertStorageMethod(storage, method, operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TelegramStorageError("timeout", operation));
    }, timeoutMs);
    const callback = (error, ...values) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null && error !== undefined) {
        reject(normalizeCallbackError(error, operation));
        return;
      }
      resolve(values);
    };

    try {
      storage[method](...args, callback);
    } catch {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TelegramStorageError("call_failed", operation));
    }
  });
}

async function mutateAndVerify({
  storage,
  method,
  args,
  operation,
  timeoutMs,
  unconfirmedCode,
  verify,
}) {
  assertStorageMethod(storage, method, operation);
  let callbackFailure = null;
  try {
    storage[method](...args, (error, confirmed) => {
      if (error !== null && error !== undefined) {
        callbackFailure = normalizeCallbackError(error, operation);
      } else if (confirmed === false) {
        callbackFailure = new TelegramStorageError(unconfirmedCode, operation);
      }
    });
  } catch {
    throw new TelegramStorageError("call_failed", operation);
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const verified = await verify();
    if (verified) return;
    if (callbackFailure) throw callbackFailure;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new TelegramStorageError("timeout", operation);
    }
    await delay(Math.min(VERIFY_INTERVAL_MS, remaining));
  }
}

function assertStorageMethod(storage, method, operation) {
  if (!storage || typeof storage[method] !== "function") {
    throw new TelegramStorageError("unsupported_storage", operation);
  }
}

function normalizeCallbackError(error, operation) {
  const nativeCode = String(error?.error ?? error?.message ?? error);
  const code = nativeCode.toUpperCase() === "UNSUPPORTED"
    ? "unsupported_storage"
    : "callback_error";
  return new TelegramStorageError(code, operation, { nativeCode });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("storage key must be a non-empty string");
  }
}

function validateValue(value) {
  if (typeof value !== "string") {
    throw new TypeError("storage value must be a string");
  }
}
