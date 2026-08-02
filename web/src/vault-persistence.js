import { bindDeactivated } from "./telegram.js";

export const META_KEY = "vault_meta_v1";
export const SLOT_A_KEY = "vault_slot_a_v1";
export const SLOT_B_KEY = "vault_slot_b_v1";
export const ACTIVE_SLOT_KEY = "active_slot_v1";
export const MANUAL_LOCK_KEY = "vault_manual_lock_v1";
export const MASTER_PASSWORD_CACHE_KEY = "master_password_cache_v1";

const VAULT_DEVICE_KEYS = [SLOT_A_KEY, SLOT_B_KEY, ACTIVE_SLOT_KEY, META_KEY, MANUAL_LOCK_KEY];
const ALLOWED_SLOT_KEYS = new Set([SLOT_A_KEY, SLOT_B_KEY]);

export class VaultPersistenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "VaultPersistenceError";
    this.code = code;
  }
}

export class VaultPersistence {
  constructor({ deviceStorage, secureStorage = null, wasm }) {
    this.device = deviceStorage;
    this.secure = secureStorage;
    this.wasm = wasm;
  }

  async inspectState() {
    const metadata = await this.device.get(META_KEY);
    if (metadata === null) {
      return { state: "uninitialized" };
    }
    return { state: "locked" };
  }

  async createSession(masterPassword, now = Date.now()) {
    if ((await this.device.get(META_KEY)) !== null) {
      throw new VaultPersistenceError("already_initialized");
    }
    const bundle = this.wasm.VaultSession.create(masterPassword, now);
    const persistentValues = {
      slotKey: bundle.slotKey,
      slotJson: bundle.slotJson,
      metadataJson: bundle.metadataJson,
      activePointerJson: bundle.activePointerJson,
    };
    const session = bundle.takeSession();
    try {
      await this.persistCreated(persistentValues);
      return session;
    } catch (error) {
      session.lock();
      throw error;
    }
  }

  async openSession(masterPassword) {
    const snapshot = await this.loadSnapshot();
    const bundle = this.wasm.VaultSession.open(
      masterPassword,
      snapshot.metadataJson,
      snapshot.slotAJson,
      snapshot.slotBJson,
      snapshot.activePointerJson,
    );
    const repairedPointerJson = bundle.repairedPointerJson;
    const session = bundle.takeSession();
    try {
      if (repairedPointerJson !== undefined && repairedPointerJson !== null) {
        await this.device.setVerified(ACTIVE_SLOT_KEY, repairedPointerJson);
      }
      return session;
    } catch (error) {
      session.lock();
      throw error;
    }
  }

  async openCachedSession() {
    if ((await this.device.get(MANUAL_LOCK_KEY)) !== null) return null;
    const masterPassword = await this.readRememberedMasterPassword();
    if (masterPassword === null) return null;

    try {
      return await this.openSession(masterPassword);
    } catch (error) {
      if (errorCode(error) === "cannot_open_vault") {
        await this.forgetMasterPassword();
        return null;
      }
      throw error;
    }
  }

  async rememberMasterPassword(masterPassword) {
    if (!this.secure) return false;
    try {
      await this.secure.setVerified(MASTER_PASSWORD_CACHE_KEY, masterPassword);
      return true;
    } catch {
      return false;
    }
  }

  async forgetMasterPassword() {
    if (!this.secure) return false;
    try {
      await this.secure.removeVerified(MASTER_PASSWORD_CACHE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  async readRememberedMasterPassword() {
    if (!this.secure) return null;
    try {
      return await this.secure.get(MASTER_PASSWORD_CACHE_KEY);
    } catch {
      return null;
    }
  }

  async markManualLock() {
    try {
      await this.device.setVerified(MANUAL_LOCK_KEY, "1");
    } catch (error) {
      await this.forgetMasterPassword();
      throw error;
    }
  }

  async clearManualLock() {
    if ((await this.device.get(MANUAL_LOCK_KEY)) !== null) {
      await this.device.removeVerified(MANUAL_LOCK_KEY);
    }
  }

  async changeMasterPassword(session, currentMasterPassword, newMasterPassword) {
    const metadataJson = session.preparePasswordChange(
      currentMasterPassword,
      newMasterPassword,
    );
    try {
      await this.device.set(META_KEY, metadataJson);
      const readback = await this.device.get(META_KEY);
      if (readback === null) {
        throw new VaultPersistenceError("missing_metadata_readback");
      }
      session.commitPasswordChange(readback);
    } catch (error) {
      session.cancelPasswordChange();
      throw error;
    }
  }

  async saveSession(session) {
    const bundle = session.prepareSave();
    if (!ALLOWED_SLOT_KEYS.has(bundle.slotKey)) {
      session.cancelPendingSave();
      throw new VaultPersistenceError("invalid_slot_key");
    }

    try {
      await this.device.set(bundle.slotKey, bundle.slotJson);
      const slotReadback = await this.device.get(bundle.slotKey);
      if (slotReadback === null) {
        throw new VaultPersistenceError("missing_slot_readback");
      }
      session.verifyPendingSlot(slotReadback);

      await this.device.set(ACTIVE_SLOT_KEY, bundle.activePointerJson);
      const pointerReadback = await this.device.get(ACTIVE_SLOT_KEY);
      if (pointerReadback === null) {
        throw new VaultPersistenceError("missing_pointer_readback");
      }
      session.commitPendingSave(pointerReadback);
    } catch (error) {
      session.cancelPendingSave();
      throw error;
    }
  }

  async destroySession(session) {
    session?.lock();

    try {
      for (const key of VAULT_DEVICE_KEYS) {
        await this.device.removeVerified(key);
      }
    } finally {
      await this.forgetMasterPassword();
    }
  }

  async loadSnapshot() {
    const [metadataJson, slotAJson, slotBJson, activePointerJson] = await Promise.all([
      this.device.get(META_KEY),
      this.device.get(SLOT_A_KEY),
      this.device.get(SLOT_B_KEY),
      this.device.get(ACTIVE_SLOT_KEY),
    ]);
    return { metadataJson, slotAJson, slotBJson, activePointerJson };
  }

  async persistCreated(bundle) {
    if (!ALLOWED_SLOT_KEYS.has(bundle.slotKey)) {
      throw new VaultPersistenceError("invalid_slot_key");
    }
    await this.device.setVerified(bundle.slotKey, bundle.slotJson);
    await this.device.setVerified(META_KEY, bundle.metadataJson);
    await this.device.setVerified(ACTIVE_SLOT_KEY, bundle.activePointerJson);
  }
}

function errorCode(error) {
  return typeof error === "string" ? error : error?.code ?? error?.message;
}

export function bindSessionAutoLock(webApp, getSession, hideSecrets = () => {}) {
  return bindDeactivated(webApp, () => {
    hideSecrets();
    getSession()?.lock();
  });
}
