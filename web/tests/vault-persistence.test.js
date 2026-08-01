import assert from "node:assert/strict";
import test from "node:test";

import { TelegramDeviceStorage } from "../src/storage.js";
import {
  ACTIVE_SLOT_KEY,
  META_KEY,
  SLOT_A_KEY,
  SLOT_B_KEY,
  VaultPersistence,
  bindSessionAutoLock,
} from "../src/vault-persistence.js";
import { MockWebApp } from "./helpers/mock-telegram.js";

function createHarness() {
  const webApp = new MockWebApp();
  const sessions = [];
  const wasm = {
    VaultSession: {
      create(_password, now) {
        assert.equal(now, 100);
        const session = createSession();
        sessions.push(session);
        return {
          slotKey: SLOT_A_KEY,
          slotJson: "slot-a-0",
          metadataJson: "metadata",
          activePointerJson: "pointer-a-0",
          takeSession: () => session,
        };
      },
      open() {
        const session = createSession();
        sessions.push(session);
        return {
          repairedPointerJson: wasm.repairedPointerJson ?? null,
          takeSession: () => session,
        };
      },
    },
  };
  const persistence = new VaultPersistence({
    deviceStorage: new TelegramDeviceStorage(webApp.DeviceStorage),
    wasm,
  });
  return { webApp, wasm, persistence, sessions };
}

function createSession() {
  return {
    locked: false,
    cancelled: false,
    slotVerified: false,
    committed: false,
    lock() {
      this.locked = true;
    },
    prepareSave() {
      return {
        slotKey: SLOT_B_KEY,
        slotJson: "slot-b-1",
        activePointerJson: "pointer-b-1",
      };
    },
    verifyPendingSlot(value) {
      assert.equal(value, "slot-b-1");
      this.slotVerified = true;
    },
    commitPendingSave(value) {
      assert.equal(this.slotVerified, true);
      assert.equal(value, "pointer-b-1");
      this.committed = true;
    },
    cancelPendingSave() {
      this.cancelled = true;
    },
  };
}

test("first creation stores slot, metadata, then pointer with readback", async () => {
  const { persistence, webApp } = createHarness();
  const session = await persistence.createSession("a long master phrase", 100);

  assert.equal(session.locked, false);
  const relevantWrites = webApp.calls.filter((call) => call.includes(".set:"));
  assert.deepEqual(relevantWrites, [
    `device.set:${SLOT_A_KEY}`,
    `device.set:${META_KEY}`,
    `device.set:${ACTIVE_SLOT_KEY}`,
  ]);
});

test("creation storage failure immediately locks the unpersisted session", async () => {
  const { persistence, webApp, sessions } = createHarness();
  webApp.DeviceStorage.failNextSetFor(META_KEY);

  await assert.rejects(persistence.createSession("a long master phrase", 100));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].locked, true);
});

test("pointer repair failure immediately locks the opened session", async () => {
  const { persistence, webApp, wasm, sessions } = createHarness();
  webApp.DeviceStorage.values.set(META_KEY, "metadata");
  webApp.DeviceStorage.values.set(SLOT_A_KEY, "slot-a-0");
  wasm.repairedPointerJson = "pointer-a-0";
  webApp.DeviceStorage.failNextSetFor(ACTIVE_SLOT_KEY);

  await assert.rejects(persistence.openSession("a long master phrase"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].locked, true);
});

test("save commits only after slot and pointer readback", async () => {
  const { persistence } = createHarness();
  const session = createSession();
  await persistence.saveSession(session);
  assert.equal(session.slotVerified, true);
  assert.equal(session.committed, true);
  assert.equal(session.cancelled, false);
});

test("partial pointer write cancels pending session state", async () => {
  const { persistence, webApp } = createHarness();
  const session = createSession();
  webApp.DeviceStorage.failNextSetFor(ACTIVE_SLOT_KEY);

  await assert.rejects(persistence.saveSession(session));
  assert.equal(session.committed, false);
  assert.equal(session.cancelled, true);
});

test("destroy needs no password and clears every vault key", async () => {
  const { persistence, webApp } = createHarness();
  const session = createSession();
  for (const key of [META_KEY, SLOT_A_KEY, SLOT_B_KEY, ACTIVE_SLOT_KEY]) {
    webApp.DeviceStorage.values.set(key, "encrypted");
  }

  await persistence.destroySession(session);

  assert.equal(session.locked, true);
  for (const key of [META_KEY, SLOT_A_KEY, SLOT_B_KEY, ACTIVE_SLOT_KEY]) {
    assert.equal(webApp.DeviceStorage.values.has(key), false);
  }
});

test("deactivated hides secrets before locking the session", () => {
  const { webApp } = createHarness();
  const order = [];
  const session = { lock: () => order.push("lock") };
  const unbind = bindSessionAutoLock(webApp, () => session, () => order.push("hide"));

  webApp.emit("deactivated");
  assert.deepEqual(order, ["hide", "lock"]);
  unbind();
  assert.equal(webApp.handlers.has("deactivated"), false);
});
