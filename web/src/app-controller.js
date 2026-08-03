import {
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  normalizeSessionTimeoutMinutes,
} from "./session-preferences.js";

const MINUTE_MS = 60_000;

export class VaultAppController {
  constructor({
    persistence,
    now = () => Date.now(),
    sessionTimeoutMinutes = DEFAULT_SESSION_TIMEOUT_MINUTES,
  }) {
    this.persistence = persistence;
    this.now = now;
    this.sessionTimeoutMinutes = normalizeSessionTimeoutMinutes(sessionTimeoutMinutes);
    this.session = null;
    this.sessionExpiresAt = null;
    this.lastSessionTimestamp = null;
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
    await this.persistence.clearLegacyAuthenticationState?.();
    const status = await this.persistence.inspectState();
    const screen = status.state === "uninitialized" ? "onboarding" : "locked";
    this.setState({ screen, entries: [], selectedId: null, editingId: null });
    return this.snapshot();
  }

  async create(masterPassword) {
    const session = await this.persistence.createSession(masterPassword, this.now());
    this.activateSession(session);
  }

  async unlock(masterPassword) {
    const session = await this.persistence.openSession(masterPassword);
    this.activateSession(session);
  }

  lock() {
    this.session?.lock();
    this.session = null;
    this.sessionExpiresAt = null;
    this.lastSessionTimestamp = null;
    this.setState({ screen: "locked", entries: [], selectedId: null, editingId: null });
  }

  async manualLock() {
    this.lock();
  }

  deactivate(now = this.now()) {
    if (!this.session) return null;
    if (!this.observeSessionTime(now)) return null;
    this.sessionExpiresAt = now + this.sessionTimeoutMilliseconds();
    return this.sessionExpiresAt;
  }

  async resume(now = this.now()) {
    if (!this.session) return this.snapshot();
    if (await this.expireAuthentication(now)) return this.snapshot();
    this.touchSession(now);
    return this.snapshot();
  }

  async changeMasterPassword(currentMasterPassword, newMasterPassword) {
    const session = this.requireSession();
    try {
      await this.persistence.changeMasterPassword(
        session,
        currentMasterPassword,
        newMasterPassword,
      );
      this.touchSession();
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
    this.sessionExpiresAt = null;
    this.lastSessionTimestamp = null;
    this.setState({ screen: "onboarding", entries: [], selectedId: null, editingId: null });
  }

  activateSession(session) {
    this.session = session;
    this.lastSessionTimestamp = null;
    this.touchSession();
    this.showVault();
  }

  getSessionTimeoutMinutes() {
    return this.sessionTimeoutMinutes;
  }

  setSessionTimeoutMinutes(minutes, now = this.now()) {
    this.sessionTimeoutMinutes = normalizeSessionTimeoutMinutes(minutes);
    this.touchSession(now);
    return this.sessionTimeoutMinutes;
  }

  touchSession(now = this.now()) {
    if (!this.session) return null;
    if (!this.observeSessionTime(now)) return null;
    this.sessionExpiresAt = now + this.sessionTimeoutMilliseconds();
    return this.sessionExpiresAt;
  }

  showVault() {
    this.refreshEntries();
    this.setState({ screen: "vault", selectedId: null, editingId: null });
  }

  authenticationDeadline() {
    return this.session ? this.sessionExpiresAt : null;
  }

  async expireAuthentication(now = this.now()) {
    if (this.session && !this.observeSessionTime(now)) return true;
    if (
      !this.session
      || this.sessionExpiresAt === null
      || now < this.sessionExpiresAt
    ) {
      return false;
    }
    this.lock();
    return true;
  }

  sessionTimeoutMilliseconds() {
    return this.sessionTimeoutMinutes * MINUTE_MS;
  }

  observeSessionTime(now) {
    if (!Number.isSafeInteger(now) || (this.lastSessionTimestamp !== null && now < this.lastSessionTimestamp)) {
      this.lock();
      return false;
    }
    this.lastSessionTimestamp = now;
    return true;
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
