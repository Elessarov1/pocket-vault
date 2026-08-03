import assert from "node:assert/strict";
import test from "node:test";

import { VaultAppController } from "../src/app-controller.js";

function createSession() {
  const entries = [];
  let nextId = 1;
  return {
    isLocked: false,
    entries,
    lock() {
      this.isLocked = true;
    },
    listEntriesJson() {
      return JSON.stringify(entries.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt })));
    },
    getEntryDetailsJson(id) {
      const { secret: _secret, ...entry } = entries.find((candidate) => candidate.id === id);
      return JSON.stringify(entry);
    },
    getEntryJson(id) {
      return JSON.stringify(entries.find((candidate) => candidate.id === id));
    },
    getEntrySecret(id) {
      return entries.find((candidate) => candidate.id === id).secret;
    },
    addEntry(title, secret, description, now) {
      const id = `entry-${nextId++}`;
      entries.push({ id, title, secret, description, createdAt: now, updatedAt: now });
      return id;
    },
    updateEntry(id, title, secret, description, now) {
      Object.assign(entries.find((candidate) => candidate.id === id), { title, secret, description, updatedAt: now });
    },
    deleteEntry(id) {
      entries.splice(entries.findIndex((candidate) => candidate.id === id), 1);
    },
  };
}

function createHarness(initialState = "uninitialized", { timeoutMinutes = 5 } = {}) {
  const session = createSession();
  const calls = [];
  const persistence = {
    async inspectState() {
      return { state: initialState };
    },
    async clearLegacyAuthenticationState() {
      calls.push(["clear-legacy-auth"]);
    },
    async createSession(password) {
      calls.push(["create", password]);
      return session;
    },
    async openSession(password) {
      calls.push(["open", password]);
      return session;
    },
    async saveSession(value) {
      calls.push(["save", value]);
    },
    async changeMasterPassword(value, current, next) {
      calls.push(["change-password", value, current, next]);
    },
    async destroySession(value) {
      calls.push(["destroy", value]);
      value?.lock();
    },
  };
  const controller = new VaultAppController({
    persistence,
    now: () => 1_000,
    sessionTimeoutMinutes: timeoutMinutes,
  });
  return { controller, persistence, session, calls };
}

test("initial screen follows persistent vault state", async () => {
  const fresh = createHarness("uninitialized").controller;
  const locked = createHarness("locked").controller;

  assert.equal((await fresh.initialize()).screen, "onboarding");
  assert.equal((await locked.initialize()).screen, "locked");
});

test("create, add, inspect, update, and delete use one unlocked session", async () => {
  const { controller, calls } = createHarness();
  await controller.initialize();
  await controller.create("long master phrase");

  controller.beginEdit();
  await controller.saveEntry({ title: "Mail", secret: "secret", description: "Primary" });
  assert.equal(controller.snapshot().entries.length, 1);
  const id = controller.snapshot().entries[0].id;
  assert.equal(controller.openEntry(id).description, "Primary");
  assert.equal(controller.getSelectedSecret(), "secret");

  controller.beginEdit(id);
  await controller.saveEntry({ title: "Mail updated", secret: "new secret", description: "" });
  assert.equal(controller.snapshot().entries[0].title, "Mail updated");
  controller.openEntry(id);
  await controller.deleteSelected();

  assert.deepEqual(controller.snapshot().entries, []);
  assert.equal(calls.filter(([name]) => name === "save").length, 3);
});

test("a persistence failure locks and discards the in-memory session", async () => {
  const { controller, persistence, session } = createHarness();
  await controller.create("long master phrase");
  controller.beginEdit();
  persistence.saveSession = async () => {
    throw new Error("device.setItem failed");
  };

  await assert.rejects(
    controller.saveEntry({ title: "Mail", secret: "secret", description: "" }),
    /failed/,
  );
  assert.equal(session.isLocked, true);
  assert.equal(controller.snapshot().screen, "locked");
  assert.deepEqual(controller.snapshot().entries, []);
});

test("forgot-password destruction works without an unlocked session", async () => {
  const { controller, calls } = createHarness("locked");
  await controller.initialize();
  await controller.destroy();

  assert.equal(controller.snapshot().screen, "onboarding");
  assert.deepEqual(calls.at(-1), ["destroy", null]);
});

test("initialization never opens a locked vault without an explicit password", async () => {
  const { controller, calls } = createHarness("locked");

  assert.equal((await controller.initialize()).screen, "locked");
  assert.equal(calls.some(([name]) => name === "open"), false);
  assert.equal(calls.some(([name]) => name === "clear-legacy-auth"), true);
});

test("manual lock drops the in-memory session and resume stays locked", async () => {
  const { controller } = createHarness();
  await controller.create("long master phrase");
  await controller.manualLock();

  assert.equal(controller.snapshot().screen, "locked");
  assert.equal((await controller.resume()).screen, "locked");
});

test("an open session expires after the configured inactivity timeout", async () => {
  const { controller, session } = createHarness();
  await controller.create("long master phrase");
  const deadline = 1_000 + 5 * 60_000;

  assert.equal(controller.authenticationDeadline(), deadline);
  assert.equal(await controller.expireAuthentication(deadline - 1), false);
  assert.equal(session.isLocked, false);
  assert.equal(await controller.expireAuthentication(deadline), true);
  assert.equal(session.isLocked, true);
  assert.equal(controller.snapshot().screen, "locked");
});

test("deactivation starts a fresh grace period and a timely resume refreshes it", async () => {
  const { controller, session } = createHarness();
  await controller.create("long master phrase");

  assert.equal(controller.deactivate(20_000), 320_000);
  assert.equal((await controller.resume(319_999)).screen, "vault");
  assert.equal(controller.authenticationDeadline(), 619_999);
  assert.equal(session.isLocked, false);
});

test("moving the clock backwards locks the session instead of extending it", async () => {
  const { controller, session } = createHarness();
  await controller.create("long master phrase");

  assert.equal(await controller.expireAuthentication(999), true);
  assert.equal(session.isLocked, true);
  assert.equal(controller.snapshot().screen, "locked");
});

test("the timeout can be changed to a preset or custom number of minutes", async () => {
  const { controller } = createHarness();
  await controller.create("long master phrase");

  assert.equal(controller.setSessionTimeoutMinutes(10, 2_000), 10);
  assert.equal(controller.authenticationDeadline(), 602_000);
  assert.equal(controller.setSessionTimeoutMinutes(7, 3_000), 7);
  assert.equal(controller.authenticationDeadline(), 423_000);
  assert.throws(() => controller.setSessionTimeoutMinutes(0), RangeError);
  assert.equal(controller.setSessionTimeoutMinutes(1_440, 4_000), 1_440);
  assert.throws(() => controller.setSessionTimeoutMinutes(1_441), RangeError);
});

test("master password change verifies the current password without persisting it", async () => {
  const { controller, calls } = createHarness();
  await controller.create("long master phrase");
  await controller.changeMasterPassword("long master phrase", "new long master phrase");

  assert.equal(controller.snapshot().screen, "settings");
  assert.equal(calls.some(([name]) => name === "change-password"), true);
  assert.equal(calls.some(([name]) => name === "remember"), false);
});

test("a wrong current password keeps the unlocked session available for correction", async () => {
  const { controller, persistence, session } = createHarness();
  await controller.create("long master phrase");
  controller.navigate("change-password");
  persistence.changeMasterPassword = async () => {
    throw "cannot_open_vault";
  };

  await assert.rejects(
    controller.changeMasterPassword("wrong long password", "new long master phrase"),
    (error) => error === "cannot_open_vault",
  );
  assert.equal(session.isLocked, false);
  assert.equal(controller.snapshot().screen, "change-password");
});
