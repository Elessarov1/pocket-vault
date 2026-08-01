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

function createHarness(initialState = "uninitialized") {
  const session = createSession();
  const calls = [];
  const persistence = {
    async inspectState() {
      return { state: initialState };
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
