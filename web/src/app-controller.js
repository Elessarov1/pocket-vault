export class VaultAppController {
  constructor({ persistence, now = () => Date.now() }) {
    this.persistence = persistence;
    this.now = now;
    this.session = null;
    this.resumePromise = null;
    this.lockRevision = 0;
    this.listeners = new Set();
    this.state = Object.freeze({ screen: "loading", entries: [], selectedId: null, editingId: null });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return { ...this.state, entries: [...this.state.entries] };
  }

  async initialize() {
    const status = await this.persistence.inspectState();
    if (status.state === "locked") {
      this.session = await this.persistence.openCachedSession();
    }
    const screen = status.state === "uninitialized"
      ? "onboarding"
      : this.session
        ? "vault"
        : "locked";
    if (this.session) {
      this.refreshEntries();
      this.setState({ screen, selectedId: null, editingId: null });
    } else {
      this.setState({ screen, entries: [], selectedId: null, editingId: null });
    }
    return this.snapshot();
  }

  async create(masterPassword) {
    this.session = await this.persistence.createSession(masterPassword, this.now());
    await this.enableAutoUnlock(masterPassword);
    this.refreshEntries();
    this.setState({ screen: "vault", selectedId: null, editingId: null });
  }

  async unlock(masterPassword) {
    this.session = await this.persistence.openSession(masterPassword);
    await this.enableAutoUnlock(masterPassword);
    this.refreshEntries();
    this.setState({ screen: "vault", selectedId: null, editingId: null });
  }

  lock() {
    this.lockRevision += 1;
    this.session?.lock();
    this.session = null;
    this.setState({ screen: "locked", entries: [], selectedId: null, editingId: null });
  }

  async manualLock() {
    try {
      await this.persistence.markManualLock();
    } finally {
      this.lock();
    }
  }

  async resume() {
    if (this.session) return this.snapshot();
    if (this.resumePromise) return this.resumePromise;
    const revision = this.lockRevision;
    this.resumePromise = (async () => {
      const session = await this.persistence.openCachedSession();
      if (revision !== this.lockRevision) {
        session?.lock();
        return this.snapshot();
      }
      this.session = session;
      if (!this.session) return this.snapshot();
      this.refreshEntries();
      this.setState({ screen: "vault", selectedId: null, editingId: null });
      return this.snapshot();
    })();
    try {
      return await this.resumePromise;
    } finally {
      this.resumePromise = null;
    }
  }

  async changeMasterPassword(currentMasterPassword, newMasterPassword) {
    const session = this.requireSession();
    try {
      await this.persistence.changeMasterPassword(
        session,
        currentMasterPassword,
        newMasterPassword,
      );
      await this.enableAutoUnlock(newMasterPassword);
      this.setState({ screen: "settings" });
    } catch (error) {
      const code = typeof error === "string" ? error : error?.code ?? error?.message;
      if (!["cannot_open_vault", "invalid_master_password"].includes(code)) this.lock();
      throw error;
    }
  }

  navigate(screen) {
    if (["vault", "settings", "change-password", "destroy"].includes(screen)) this.requireSession();
    this.setState({ screen });
  }

  openEntry(id) {
    const session = this.requireSession();
    const details = JSON.parse(session.getEntryDetailsJson(id));
    this.setState({ screen: "detail", selectedId: id, editingId: null });
    return details;
  }

  beginEdit(id = null) {
    const session = this.requireSession();
    const entry = id === null ? null : JSON.parse(session.getEntryJson(id));
    this.setState({ screen: "edit", editingId: id, selectedId: id });
    return entry;
  }

  getSelectedDetails() {
    const session = this.requireSession();
    if (!this.state.selectedId) throw new Error("entry_not_selected");
    return JSON.parse(session.getEntryDetailsJson(this.state.selectedId));
  }

  getSelectedSecret() {
    const session = this.requireSession();
    if (!this.state.selectedId) throw new Error("entry_not_selected");
    return session.getEntrySecret(this.state.selectedId);
  }

  getEditingEntry() {
    const session = this.requireSession();
    return this.state.editingId === null ? null : JSON.parse(session.getEntryJson(this.state.editingId));
  }

  async saveEntry({ title, secret, description }) {
    const session = this.requireSession();
    const normalizedDescription = description.trim() === "" ? undefined : description;
    try {
      if (this.state.editingId === null) {
        session.addEntry(title, secret, normalizedDescription, this.now());
      } else {
        session.updateEntry(this.state.editingId, title, secret, normalizedDescription, this.now());
      }
      await this.persistence.saveSession(session);
      this.refreshEntries();
      this.setState({ screen: "vault", selectedId: null, editingId: null });
    } catch (error) {
      this.lock();
      throw error;
    }
  }

  async deleteSelected() {
    const session = this.requireSession();
    if (!this.state.selectedId) throw new Error("entry_not_selected");
    try {
      session.deleteEntry(this.state.selectedId, this.now());
      await this.persistence.saveSession(session);
      this.refreshEntries();
      this.setState({ screen: "vault", selectedId: null, editingId: null });
    } catch (error) {
      this.lock();
      throw error;
    }
  }

  async destroy() {
    const session = this.session;
    await this.persistence.destroySession(session);
    this.session = null;
    this.setState({ screen: "onboarding", entries: [], selectedId: null, editingId: null });
  }

  async enableAutoUnlock(masterPassword) {
    try {
      await this.persistence.clearManualLock();
    } catch {
      // The current session stays usable; the next launch will ask again.
    }
    await this.persistence.rememberMasterPassword(masterPassword);
  }

  refreshEntries() {
    const session = this.requireSession();
    const entries = JSON.parse(session.listEntriesJson());
    entries.sort((left, right) => right.updatedAt - left.updatedAt);
    this.state = Object.freeze({ ...this.state, entries });
  }

  requireSession() {
    if (!this.session || this.session.isLocked) throw new Error("locked");
    return this.session;
  }

  setState(patch) {
    this.state = Object.freeze({ ...this.state, ...patch });
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
