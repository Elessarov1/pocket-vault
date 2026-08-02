import assert from "node:assert/strict";
import test from "node:test";

import { VaultAppController } from "../src/app-controller.js";
import { nextLocalDayStart } from "../src/vault-persistence.js";

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

function createHarness(initialState = "uninitialized") {
  const session = createSession();
  const calls = [];
  const persistence = {
    async inspectState() {
      return { state: initialState };
    },
    async openCachedSession(now) {
      calls.push(["open-cached", now]);
      return persistence.cachedSession ?? null;
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
    async rememberMasterPassword(password, rememberedAt) {
      calls.push(["remember", password, rememberedAt]);
      return true;
    },
    async clearManualLock() {
      calls.push(["clear-manual-lock"]);
    },
    async markManualLock() {
      calls.push(["manual-lock"]);
    },
    async forgetMasterPassword() {
      calls.push(["forget"]);
      return true;
    },
    async changeMasterPassword(value, current, next) {
      calls.push(["change-password", value, current, next]);
    },
    async destroySession(value) {
      calls.push(["destroy", value]);
      value?.lock();
    },
  };
  const controller = new VaultAppController({ persistence, now: () => 1_000 });
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

test("a cached password opens a locked vault automatically", async () => {
  const { controller, persistence, session, calls } = createHarness("locked");
  persistence.cachedSession = { session, expiresAt: nextLocalDayStart(1_000) };

  assert.equal((await controller.initialize()).screen, "vault");
  assert.deepEqual(calls.at(-1), ["open-cached", 1_000]);
});

test("manual lock persists intent and resume stays locked", async () => {
  const { controller, calls } = createHarness();
  await controller.create("long master phrase");
  await controller.manualLock();

  assert.equal(controller.snapshot().screen, "locked");
  assert.equal(calls.some(([name]) => name === "manual-lock"), true);
  assert.equal((await controller.resume()).screen, "locked");
});

test("an open session expires at the next local midnight", async () => {
  const { controller, session, calls } = createHarness();
  await controller.create("long master phrase");
  const deadline = nextLocalDayStart(1_000);

  assert.equal(controller.authenticationDeadline(), deadline);
  assert.equal(await controller.expireAuthentication(deadline - 1), false);
  assert.equal(session.isLocked, false);
  assert.equal(await controller.expireAuthentication(deadline), true);
  assert.equal(session.isLocked, true);
  assert.equal(controller.snapshot().screen, "locked");
  assert.equal(calls.some(([name]) => name === "forget"), true);
});

test("master password change verifies the current password and refreshes the cache", async () => {
  const { controller, calls } = createHarness();
  await controller.create("long master phrase");
  await controller.changeMasterPassword("long master phrase", "new long master phrase");

  assert.equal(controller.snapshot().screen, "settings");
  assert.equal(calls.some(([name]) => name === "change-password"), true);
  assert.deepEqual(calls.at(-1), ["remember", "new long master phrase", 1_000]);
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
