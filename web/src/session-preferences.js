export const DEFAULT_SESSION_TIMEOUT_MINUTES = 5;
export const MIN_SESSION_TIMEOUT_MINUTES = 1;
export const MAX_SESSION_TIMEOUT_MINUTES = 1_440;
export const SESSION_TIMEOUT_STORAGE_KEY = "pocket-vault-session-timeout-minutes";

export function normalizeSessionTimeoutMinutes(value) {
  const minutes = Number(value);
  if (
    !Number.isInteger(minutes)
    || minutes < MIN_SESSION_TIMEOUT_MINUTES
    || minutes > MAX_SESSION_TIMEOUT_MINUTES
  ) {
    throw new RangeError("session timeout must be an integer from 1 to 1440 minutes");
  }
  return minutes;
}

export function loadSessionTimeoutMinutes(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem(SESSION_TIMEOUT_STORAGE_KEY);
    return stored === null || stored === undefined
      ? DEFAULT_SESSION_TIMEOUT_MINUTES
      : normalizeSessionTimeoutMinutes(stored);
  } catch {
    return DEFAULT_SESSION_TIMEOUT_MINUTES;
  }
}

export function saveSessionTimeoutMinutes(minutes, storage = globalThis.localStorage) {
  const normalized = normalizeSessionTimeoutMinutes(minutes);
  try {
    storage?.setItem(SESSION_TIMEOUT_STORAGE_KEY, String(normalized));
  } catch {
    // The preference is non-critical and the in-memory setting still applies.
  }
  return normalized;
}
