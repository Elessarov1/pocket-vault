import { bindDeactivated } from "./telegram.js";

export const DEVICE_SECRET_KEY = "device_secret_v1";
export const META_KEY = "vault_meta_v1";
export const SLOT_A_KEY = "vault_slot_a_v1";
export const SLOT_B_KEY = "vault_slot_b_v1";
export const ACTIVE_SLOT_KEY = "active_slot_v1";

const VAULT_DEVICE_KEYS = [SLOT_A_KEY, SLOT_B_KEY, ACTIVE_SLOT_KEY, META_KEY];
const ALLOWED_SLOT_KEYS = new Set([SLOT_A_KEY, SLOT_B_KEY]);

export class VaultPersistenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "VaultPersistenceError";
    this.code = code;
  }
}

export class VaultPersistence {
  constructor({ deviceStorage, secureStorage, wasm }) {
    this.device = deviceStorage;
    this.secure = secureStorage;
    this.wasm = wasm;
  }

  async inspectState() {
    const [metadata, deviceSecret] = await Promise.all([
      this.device.get(META_KEY),
      this.secure.get(DEVICE_SECRET_KEY),
    ]);
    if (metadata === null) {
      return {
        state: "uninitialized",
        canRestoreDeviceSecret: deviceSecret.canRestore,
      };
    }
    if (deviceSecret.value === null) {
      return {
        state: "missing_device_secret",
        canRestoreDeviceSecret: deviceSecret.canRestore,
      };
    }
    return { state: "locked", canRestoreDeviceSecret: false };
  }

  async createSession(masterPassword, now = Date.now()) {
    if ((await this.device.get(META_KEY)) !== null) {
      throw new VaultPersistenceError("already_initialized");
    }
    const deviceSecret = await this.ensureDeviceSecret();
    const bundle = this.wasm.VaultSession.create(masterPassword, deviceSecret, now);
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
    const secureValue = await this.secure.get(DEVICE_SECRET_KEY);
    if (secureValue.value === null) {
      throw new VaultPersistenceError("missing_device_secret");
    }
    const snapshot = await this.loadSnapshot();
    const bundle = this.wasm.VaultSession.open(
      masterPassword,
      secureValue.value,
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
    const tombstone = this.wasm.generateDeviceSecretEnvelope();
    await this.secure.setVerified(DEVICE_SECRET_KEY, tombstone);
    session?.lock();

    for (const key of VAULT_DEVICE_KEYS) {
      await this.device.removeVerified(key);
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

  async ensureDeviceSecret() {
    const current = await this.secure.get(DEVICE_SECRET_KEY);
    if (current.value !== null) {
      this.wasm.validateDeviceSecretEnvelope(current.value);
      return current.value;
    }

    // Deliberately do not call SecureStorage.restoreItem(), even when
    // current.canRestore is true. A fresh key preserves no-recovery semantics.
    const generated = this.wasm.generateDeviceSecretEnvelope();
    await this.secure.setVerified(DEVICE_SECRET_KEY, generated);
    return generated;
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

export function bindSessionAutoLock(webApp, getSession, hideSecrets = () => {}) {
  return bindDeactivated(webApp, () => {
    hideSecrets();
    getSession()?.lock();
  });
}
