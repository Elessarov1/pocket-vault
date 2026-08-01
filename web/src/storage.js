const DEFAULT_TIMEOUT_MS = 10_000;
const VERIFY_INTERVAL_MS = 50;

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
    const [value] = await invoke(
      this.storage,
      "getItem",
      [key],
      this.timeoutMs,
      "device.getItem",
    );
    if (value !== null && typeof value !== "string") {
      throw new TelegramStorageError("invalid_response", "device.getItem");
    }
    return value;
  }

  async set(key, value) {
    validateKey(key);
    validateValue(value);
    await mutateAndVerify({
      storage: this.storage,
      method: "setItem",
      args: [key, value],
      operation: "device.setItem",
      timeoutMs: this.timeoutMs,
      unconfirmedCode: "write_not_confirmed",
      verify: async () => (await this.get(key)) === value,
    });
  }

  async setVerified(key, value) {
    await this.set(key, value);
  }

  async remove(key) {
    validateKey(key);
    await mutateAndVerify({
      storage: this.storage,
      method: "removeItem",
      args: [key],
      operation: "device.removeItem",
      timeoutMs: this.timeoutMs,
      unconfirmedCode: "remove_not_confirmed",
      verify: async () => (await this.get(key)) === null,
    });
  }

  async removeVerified(key) {
    await this.remove(key);
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
      "secure.getItem",
    );
    if (value !== null && typeof value !== "string") {
      throw new TelegramStorageError("invalid_response", "secure.getItem");
    }
    return { value, canRestore: value === null && canRestore === true };
  }

  async set(key, value) {
    validateKey(key);
    validateValue(value);
    await mutateAndVerify({
      storage: this.storage,
      method: "setItem",
      args: [key, value],
      operation: "secure.setItem",
      timeoutMs: this.timeoutMs,
      unconfirmedCode: "write_not_confirmed",
      verify: async () => (await this.get(key)).value === value,
    });
  }

  async setVerified(key, value) {
    await this.set(key, value);
  }
}

function invoke(storage, method, args, timeoutMs, operation = method) {
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
        reject(new TelegramStorageError("callback_error", operation));
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
  let callbackFailure = null;
  try {
    storage[method](...args, (error, confirmed) => {
      if (error !== null && error !== undefined) {
        callbackFailure = new TelegramStorageError("callback_error", operation);
      } else if (confirmed === false) {
        callbackFailure = new TelegramStorageError(unconfirmedCode, operation);
      }
    });
  } catch {
    throw new TelegramStorageError("call_failed", operation);
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (callbackFailure) throw callbackFailure;
    const verified = await verify();
    if (callbackFailure) throw callbackFailure;
    if (verified) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new TelegramStorageError("timeout", operation);
    }
    await delay(Math.min(VERIFY_INTERVAL_MS, remaining));
  }
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
