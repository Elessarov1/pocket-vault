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
    const metadata = await this.device.getExisting(META_KEY);
    if (metadata === null) {
      return { state: "uninitialized" };
    }
    return { state: "locked" };
  }

  async createSession(masterPassword, now = Date.now()) {
    if ((await this.device.getExisting(META_KEY)) !== null) {
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

  async clearLegacyAuthenticationState() {
    const removals = [this.device.removeVerified(MANUAL_LOCK_KEY)];
    if (this.secure) {
      removals.push(this.secure.removeVerified(MASTER_PASSWORD_CACHE_KEY));
    }
    await Promise.allSettled(removals);
  }

  async changeMasterPassword(session, currentMasterPassword, newMasterPassword) {
    const metadataJson = session.preparePasswordChange(
      currentMasterPassword,
      newMasterPassword,
    );
    try {
      await this.device.set(META_KEY, metadataJson);
      const readback = await this.device.getExisting(META_KEY);
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
      const slotReadback = await this.device.getExisting(bundle.slotKey);
      if (slotReadback === null) {
        throw new VaultPersistenceError("missing_slot_readback");
      }
      session.verifyPendingSlot(slotReadback);

      await this.device.set(ACTIVE_SLOT_KEY, bundle.activePointerJson);
      const pointerReadback = await this.device.getExisting(ACTIVE_SLOT_KEY);
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
      if (this.secure) {
        await this.secure.removeVerified(MASTER_PASSWORD_CACHE_KEY);
      }
    }
  }

  async loadSnapshot() {
    const [metadataJson, slotAJson, slotBJson, activePointerJson] = await Promise.all([
      this.device.getExisting(META_KEY),
      this.device.getExisting(SLOT_A_KEY),
      this.device.getExisting(SLOT_B_KEY),
      this.device.getExisting(ACTIVE_SLOT_KEY),
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
