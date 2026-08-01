export class VaultAppController {
  constructor({ persistence, now = () => Date.now() }) {
    this.persistence = persistence;
    this.now = now;
    this.session = null;
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
    const screen = status.state === "uninitialized" ? "onboarding" : "locked";
    this.setState({ screen, entries: [], selectedId: null, editingId: null });
    return this.snapshot();
  }

  async create(masterPassword) {
    this.session = await this.persistence.createSession(masterPassword, this.now());
    this.refreshEntries();
    this.setState({ screen: "vault", selectedId: null, editingId: null });
  }

  async unlock(masterPassword) {
    this.session = await this.persistence.openSession(masterPassword);
    this.refreshEntries();
    this.setState({ screen: "vault", selectedId: null, editingId: null });
  }

  lock() {
    this.session?.lock();
    this.session = null;
    this.setState({ screen: "locked", entries: [], selectedId: null, editingId: null });
  }

  navigate(screen) {
    if (["vault", "settings", "destroy"].includes(screen)) this.requireSession();
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
