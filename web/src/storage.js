const DEFAULT_TIMEOUT_MS = 10_000;

export class TelegramStorageError extends Error {
  constructor(code, operation) {
    super(`${operation} failed`);
    this.name = "TelegramStorageError";
    this.code = code;
    this.operation = operation;
  }
}

export class TelegramDeviceStorage {
  constructor(storage, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.storage = storage;
    this.timeoutMs = timeoutMs;
  }

  async get(key) {
    validateKey(key);
    const [value] = await invoke(this.storage, "getItem", [key], this.timeoutMs);
    if (value !== null && typeof value !== "string") {
      throw new TelegramStorageError("invalid_response", "device.getItem");
    }
    return value;
  }

  async set(key, value) {
    validateKey(key);
    validateValue(value);
    const [stored] = await invoke(this.storage, "setItem", [key, value], this.timeoutMs);
    if (stored !== true) {
      throw new TelegramStorageError("write_not_confirmed", "device.setItem");
    }
  }

  async setVerified(key, value) {
    await this.set(key, value);
    if ((await this.get(key)) !== value) {
      throw new TelegramStorageError("readback_mismatch", "device.setItem");
    }
  }

  async remove(key) {
    validateKey(key);
    await invoke(this.storage, "removeItem", [key], this.timeoutMs);
  }

  async removeVerified(key) {
    await this.remove(key);
    if ((await this.get(key)) !== null) {
      throw new TelegramStorageError("remove_not_confirmed", "device.removeItem");
    }
  }
}

export class TelegramSecureStorage {
  constructor(storage, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.storage = storage;
    this.timeoutMs = timeoutMs;
  }

  async get(key) {
    validateKey(key);
    const [value, canRestore = false] = await invoke(
      this.storage,
      "getItem",
      [key],
      this.timeoutMs,
    );
    if (value !== null && typeof value !== "string") {
      throw new TelegramStorageError("invalid_response", "secure.getItem");
    }
    return { value, canRestore: value === null && canRestore === true };
  }

  async set(key, value) {
    validateKey(key);
    validateValue(value);
    const [stored] = await invoke(this.storage, "setItem", [key, value], this.timeoutMs);
    if (stored !== true) {
      throw new TelegramStorageError("write_not_confirmed", "secure.setItem");
    }
  }

  async setVerified(key, value) {
    await this.set(key, value);
    const readback = await this.get(key);
    if (readback.value !== value) {
      throw new TelegramStorageError("readback_mismatch", "secure.setItem");
    }
  }
}

function invoke(storage, method, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TelegramStorageError("timeout", method));
    }, timeoutMs);
    const callback = (error, ...values) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null && error !== undefined) {
        reject(new TelegramStorageError("callback_error", method));
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
      reject(new TelegramStorageError("call_failed", method));
    }
  });
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
