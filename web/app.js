import { VaultAppController } from "./src/app-controller.js";
import { initializePreviewRuntime, initializeVaultRuntime } from "./src/bootstrap.js";
import {
  getLanguage,
  getLocale,
  initializeLanguage,
  t,
  toggleLanguage,
  translateRoot,
} from "./src/i18n.js";
import { isPreviewLocation } from "./src/preview-runtime.js";
import {
  initializeTheme,
  setTheme,
  toggleTheme,
  updateThemeControls,
} from "./src/theme.js";

const validScreens = new Set([
  "onboarding",
  "locked",
  "vault",
  "detail",
  "edit",
  "settings",
  "destroy",
  "unsupported",
]);

const appScreen = document.querySelector("#app-screen");
const screenPicker = document.querySelector("#screen-picker");
const toast = document.querySelector("#toast");
let controller;
let runtime;
let currentScreen = "loading";
let toastTimer;
let revealTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function renderLoading() {
  const section = document.createElement("section");
  section.className = "screen screen--loading";
  section.setAttribute("aria-busy", "true");
  const mark = document.createElement("span");
  mark.className = "loading-mark";
  mark.textContent = "PV";
  const title = document.createElement("h2");
  title.textContent = t("Открываем защищённое хранилище…");
  section.append(mark, title);
  appScreen.replaceChildren(section);
}

function renderScreen(name) {
  if (!validScreens.has(name)) return;
  const template = document.querySelector(`#screen-${name}`);
  if (!template) return;

  hideVisibleSecret();
  currentScreen = name;
  appScreen.replaceChildren(template.content.cloneNode(true));
  translateRoot(appScreen);
  updateThemeControls(appScreen);
  appScreen.scrollTop = 0;
  screenPicker.value = name;
  updateReviewNavigation(name);

  if (name === "vault" && controller) populateEntryList(controller.snapshot().entries);
  if (name === "detail" && controller) populateEntryDetails();
  if (name === "edit" && controller) populateEntryForm();
  bindScreenInteractions();
}

function updateReviewNavigation(name) {
  document.querySelectorAll("[data-screen]").forEach((button) => {
    const active = button.dataset.screen === name;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
}

function populateEntryList(entries) {
  const list = document.querySelector("#entry-list");
  const count = document.querySelector("#entry-count");
  const empty = document.querySelector("#empty-search");
  if (!list || !count || !empty) return;

  count.textContent = formatEntryCount(entries.length);
  const renderEntries = (items, query = "") => {
    list.replaceChildren(...items.map(createEntryCard));
    const hasEntries = entries.length > 0;
    empty.hidden = items.length > 0;
    empty.textContent = hasEntries
      ? getLanguage() === "en"
        ? `No results for “${query}”.`
        : `По запросу «${query}» ничего не найдено.`
      : t("Записей пока нет. Добавьте первый пароль или секрет.");
    list.querySelectorAll("[data-entry-id]").forEach((button) => {
      button.addEventListener("click", () => runAction(() => controller.openEntry(button.dataset.entryId)));
    });
  };

  let ascending = false;
  let query = "";
  const apply = () => {
    const normalized = query.trim().toLocaleLowerCase(getLocale());
    const filtered = entries.filter((entry) => entry.title.toLocaleLowerCase(getLocale()).includes(normalized));
    if (ascending) filtered.reverse();
    renderEntries(filtered, query.trim());
  };
  apply();

  document.querySelector("#entry-search")?.addEventListener("input", (event) => {
    query = event.target.value;
    apply();
  });
  document.querySelector("[data-sort]")?.addEventListener("click", (event) => {
    ascending = !ascending;
    event.currentTarget.innerHTML = `${t("По обновлению")} <b>${ascending ? "↑" : "↓"}</b>`;
    apply();
  });
}

function createEntryCard(entry, index) {
  const button = document.createElement("button");
  button.className = "entry-card";
  button.type = "button";
  button.dataset.entryId = entry.id;

  const icon = document.createElement("span");
  const colors = ["mint", "peach", "blue", "lilac"];
  icon.className = `entry-icon entry-icon--${colors[index % colors.length]}`;
  icon.append(createLockIcon());

  const copy = document.createElement("span");
  copy.className = "entry-copy";
  const title = document.createElement("strong");
  title.textContent = entry.title;
  const kind = document.createElement("small");
  kind.textContent = t("Пароль или секрет");
  copy.append(title, kind);

  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = formatRelativeDate(entry.updatedAt);
  button.append(icon, copy, time, createChevron());
  return button;
}

function createLockIcon() {
  const svg = createSvg("0 0 24 24", "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function createChevron() {
  const svg = createSvg("0 0 24 24", "m9 5 7 7-7 7");
  svg.classList.add("chevron");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function createSvg(viewBox, pathData) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}

function populateEntryDetails() {
  try {
    const entry = controller.getSelectedDetails();
    document.querySelector("#detail-title").textContent = entry.title;
    const description = document.querySelector("#detail-description");
    description.textContent = entry.description ?? t("Без описания");
    document.querySelector("#detail-created").textContent = formatFullDate(entry.createdAt);
    document.querySelector("#detail-updated").textContent = formatFullDate(entry.updatedAt);
  } catch (error) {
    showError(error);
    controller.navigate("vault");
  }
}

function populateEntryForm() {
  let entry = null;
  try {
    entry = controller.getEditingEntry();
  } catch {
    return;
  }
  if (!entry) return;
  document.querySelector("#record-form-title").textContent = t("Изменить запись");
  document.querySelector("#record-form-eyebrow").textContent = t("Сохранённый пароль или секрет");
  document.querySelector("#record-form-heading").textContent = t("Обновите запись");
  document.querySelector("#record-title").value = entry.title;
  document.querySelector("#record-secret").value = entry.secret;
  document.querySelector("#record-description").value = entry.description ?? "";
  updateCounters();
}

function bindScreenInteractions() {
  document.querySelectorAll("[data-language-toggle], [data-language-switch]").forEach((button) => {
    button.addEventListener("click", switchLanguage);
  });
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.addEventListener("click", switchTheme);
  });
  document.querySelectorAll("[data-go]").forEach((button) => {
    button.addEventListener("click", () => {
      const destination = button.dataset.go;
      runAction(() => {
        if (destination === "locked") controller.lock();
        else if (destination === "edit") controller.beginEdit(currentScreen === "detail" ? controller.snapshot().selectedId : null);
        else controller.navigate(destination);
      });
    });
  });

  document.querySelectorAll("[data-toggle-password]").forEach((button) => {
    button.addEventListener("click", () => togglePassword(button));
  });
  document.querySelectorAll("[data-open-sheet]").forEach((button) => {
    button.addEventListener("click", () => openSheet(button.dataset.openSheet));
  });
  document.querySelectorAll("[data-close-sheet]").forEach((button) => {
    button.addEventListener("click", () => closeSheet(button.closest(".sheet-backdrop")));
  });
  document.querySelectorAll(".sheet-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeSheet(backdrop);
    });
  });

  const creationPassword = document.querySelector("#create-password");
  creationPassword?.addEventListener("input", () => updateStrength(creationPassword));
  document.querySelector("#creation-form")?.addEventListener("submit", handleCreate);
  document.querySelector("#unlock-form")?.addEventListener("submit", handleUnlock);

  document.querySelectorAll(".field input[maxlength], .field textarea[maxlength]").forEach((field) => {
    field.addEventListener("input", updateCounters);
  });
  document.querySelector("#record-form")?.addEventListener("submit", handleSaveEntry);
  document.querySelector("[data-reveal]")?.addEventListener("click", toggleSecret);
  document.querySelector("[data-copy]")?.addEventListener("click", copySecret);
  document.querySelector("[data-delete-entry]")?.addEventListener("click", () => openSheet("delete-entry-sheet"));
  document.querySelector("#delete-entry-form")?.addEventListener("submit", handleDeleteEntry);
  document.querySelector("[data-source]")?.addEventListener("click", () => {
    window.open("https://github.com/Elessarov1/pocket-vault", "_blank", "noopener,noreferrer");
  });
  document.querySelector("[data-privacy]")?.addEventListener("click", () => {
    window.open("./privacy.html", "_blank", "noopener,noreferrer");
  });
  document.querySelector("[data-start-unverified-reset]")?.addEventListener("click", showForgotConfirmation);
  bindDestroyForm(document.querySelector("#forgot-reset-form"), "#forgot-confirmation-word");
  bindDestroyForm(document.querySelector("#destroy-form"), "#destroy-word");
  document.querySelector("[data-check-again]")?.addEventListener("click", () => location.reload());
}

async function handleCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const passwordInput = form.querySelector("#create-password");
  const confirmationInput = form.querySelector("#confirm-password");
  const password = passwordInput.value;
  const confirmation = confirmationInput.value;
  if (Array.from(password).length < 16) return showToast(t("Мастер-пароль должен быть не короче 16 символов"));
  if (password !== confirmation) return showToast(t("Мастер-пароли не совпадают"));
  if (!form.querySelector("#no-recovery-confirm").checked) return showToast(t("Подтвердите предупреждение об отсутствии восстановления"));

  passwordInput.value = "";
  confirmationInput.value = "";
  await runBusy(form, t("Создаём…"), () => controller.create(password));
}

async function handleUnlock(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.querySelector("#unlock-password");
  const password = input.value;
  if (!password) return showToast(t("Введите мастер-пароль"));
  input.value = "";
  await runBusy(form, t("Открываем…"), () => controller.unlock(password));
}

async function handleSaveEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const titleInput = form.querySelector("#record-title");
  const secretInput = form.querySelector("#record-secret");
  const descriptionInput = form.querySelector("#record-description");
  const values = {
    title: titleInput.value,
    secret: secretInput.value,
    description: descriptionInput.value,
  };
  titleInput.value = "";
  secretInput.value = "";
  descriptionInput.value = "";
  const saved = await runBusy(form, t("Сохраняем…"), () => controller.saveEntry(values));
  if (saved) showToast(t("Запись зашифрована и сохранена"));
}

async function handleDeleteEntry(event) {
  event.preventDefault();
  const deleted = await runBusy(event.currentTarget, t("Удаляем…"), () => controller.deleteSelected());
  if (deleted) showToast(t("Запись удалена"));
}

function bindDestroyForm(form, inputSelector) {
  if (!form) return;
  const confirmation = form.querySelector(inputSelector);
  const submit = form.querySelector("button[type='submit']");
  const update = () => {
    submit.disabled = confirmation.value !== t("УДАЛИТЬ");
  };
  confirmation.addEventListener("input", update);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (confirmation.value !== t("УДАЛИТЬ")) return;
    confirmation.value = "";
    const destroyed = await runBusy(form, t("Уничтожаем…"), () => controller.destroy());
    if (destroyed) showToast(t("Хранилище уничтожено без восстановления"));
  });
}

function showForgotConfirmation() {
  const intro = document.querySelector("[data-forgot-intro]");
  const confirmation = document.querySelector("#forgot-reset-form");
  if (!intro || !confirmation) return;
  intro.hidden = true;
  confirmation.hidden = false;
  confirmation.querySelector("input")?.focus();
}

async function runBusy(form, label, action) {
  const button = form.querySelector("button[type='submit']");
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = label;
  await nextPaint();
  try {
    await action();
    return true;
  } catch (error) {
    showError(error);
    return false;
  } finally {
    if (button.isConnected) {
      button.textContent = previous;
      button.disabled = false;
    }
  }
}

async function runAction(action) {
  try {
    return await action();
  } catch (error) {
    showError(error);
    return false;
  }
}

function showError(error) {
  const code = typeof error === "string" ? error : error?.code ?? error?.message ?? "unknown";
  const messages = {
    cannot_open_vault: t("Неверный мастер-пароль или хранилище повреждено"),
    invalid_master_password: t("Мастер-пароль не соответствует требованиям"),
    already_initialized: t("Хранилище на этом устройстве уже существует"),
    locked: t("Сначала разблокируйте хранилище"),
    entry_not_found: t("Запись не найдена"),
    vault_too_large: t("Хранилище достигло допустимого размера"),
    unsupported_telegram: t("Нужна новая версия Telegram"),
    unsupported_storage: t("Локальное хранилище недоступно в этом клиенте Telegram"),
    invalid_kdf_parameters: t("Параметры защиты хранилища не поддерживаются"),
    random_unavailable: t("Не удалось получить безопасную случайность. Перезапустите Telegram"),
    vault_operation_failed: t("Не удалось выполнить шифрование на этом устройстве"),
  };
  const storageFailure =
    error?.name === "TelegramStorageError" ||
    String(code).includes("storage") ||
    String(code).includes("failed") ||
    String(code).includes("readback");
  const fallback = storageFailure
    ? t("Не удалось сохранить данные в Telegram")
    : t("Операция не выполнена");
  const diagnostic = error?.operation ? `${error.operation}:${code}` : String(code);
  console.error("Pocket Vault operation failed", {
    name: error?.name ?? typeof error,
    code: String(code),
    operation: error?.operation ?? null,
    nativeCode: error?.nativeCode ?? null,
  });
  showToast(messages[code] ?? `${fallback} · ${t("Код")}: ${diagnostic.slice(0, 64)}`);
}

function togglePassword(button) {
  const input = document.getElementById(button.dataset.togglePassword);
  if (!input) return;
  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  button.textContent = visible ? t("Скрыть") : t("Показать");
}

function updateStrength(input) {
  const length = Array.from(input.value).length;
  const score = length === 0 ? 0 : length < 12 ? 1 : length < 16 ? 2 : length < 24 ? 3 : 4;
  const labels = [
    t("Лучше всего — 6–7 случайных слов"),
    t("Слишком короткий мастер-пароль"),
    t("Добавьте ещё несколько слов"),
    t("Хорошая длина"),
    t("Отличная длина"),
  ];
  document.querySelectorAll(".strength-bars i").forEach((bar, index) => bar.classList.toggle("is-filled", index < score));
  const label = document.querySelector("#strength-label");
  if (label) label.textContent = labels[score];
}

function updateCounters() {
  document.querySelectorAll(".field input[maxlength], .field textarea[maxlength]").forEach((field) => {
    const counter = field.closest(".field")?.querySelector("small span");
    if (counter) counter.textContent = Array.from(field.value).length;
  });
}

function toggleSecret() {
  const value = document.querySelector("#secret-value");
  const button = document.querySelector("[data-reveal]");
  const badge = document.querySelector(".private-badge");
  if (!value || !button || !badge) return;
  if (value.classList.contains("is-visible")) {
    hideVisibleSecret();
    return;
  }

  try {
    let secret = controller.getSelectedSecret();
    value.textContent = secret;
    secret = null;
    value.classList.add("is-visible");
    button.querySelector("span").textContent = t("Скрыть");
    badge.lastChild.textContent = ` ${t("Показан")}`;
    revealTimer = setTimeout(hideVisibleSecret, 15_000);
  } catch (error) {
    showError(error);
  }
}

function hideVisibleSecret() {
  clearTimeout(revealTimer);
  const value = document.querySelector("#secret-value");
  const button = document.querySelector("[data-reveal]");
  const badge = document.querySelector(".private-badge");
  if (value) {
    value.textContent = "••••••••••••••";
    value.classList.remove("is-visible");
  }
  if (button) button.querySelector("span").textContent = t("Показать");
  if (badge) badge.lastChild.textContent = ` ${t("Скрыт")}`;
}

async function copySecret() {
  try {
    let secret = controller.getSelectedSecret();
    await navigator.clipboard.writeText(secret);
    secret = null;
    showToast(t("Секрет скопирован"));
  } catch (error) {
    showToast(error?.name === "NotAllowedError" ? t("Браузер не разрешил доступ к буферу обмена") : t("Не удалось скопировать секрет"));
  }
}

function openSheet(id) {
  const sheet = document.getElementById(id);
  if (!sheet) return;
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  sheet.querySelector("[data-close-sheet]")?.focus();
}

function closeSheet(sheet) {
  if (!sheet) return;
  sheet.classList.remove("is-open");
  setTimeout(() => {
    if (sheet.isConnected) sheet.hidden = true;
  }, 180);
}

function switchLanguage() {
  toggleLanguage();
  updateThemeControls(document);
  if (currentScreen === "loading") renderLoading();
  else if (runtime?.mode === "preview" && ["vault", "detail"].includes(currentScreen)) {
    renderScreen(currentScreen);
  }
}

function switchTheme() {
  toggleTheme();
}

function requestReviewScreen(screen) {
  if (runtime?.mode !== "preview") return;
  if (["vault", "settings", "destroy"].includes(screen)) {
    runAction(() => controller.navigate(screen));
  } else if (screen === "detail" && controller.snapshot().selectedId) {
    runAction(() => controller.openEntry(controller.snapshot().selectedId));
  } else if (screen === "edit" && controller.session) {
    runAction(() => controller.beginEdit());
  } else {
    renderScreen(screen);
  }
}

function bindGlobalInteractions() {
  document.querySelectorAll("[data-language-toggle], [data-language-switch]").forEach((button) => {
    button.addEventListener("click", switchLanguage);
  });
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.addEventListener("click", switchTheme);
  });
  document.querySelectorAll("[data-screen]").forEach((button) => {
    button.addEventListener("click", () => requestReviewScreen(button.dataset.screen));
  });
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
  });
  screenPicker.addEventListener("change", () => requestReviewScreen(screenPicker.value));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSheet(document.querySelector(".sheet-backdrop.is-open"));
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      document.querySelector("#entry-search")?.focus();
    }
  });
}

function bindLifecycle() {
  if (typeof runtime.webApp.onEvent !== "function") return;
  runtime.webApp.onEvent("deactivated", () => {
    if (!controller?.session) return;
    hideVisibleSecret();
    renderScreen("locked");
    controller.lock();
  });
}

function bindKeyboardAvoidance() {
  const revealActiveControl = () => {
    if (runtime?.mode !== "telegram") return;
    const active = document.activeElement;
    if (!active?.matches("input, textarea, select")) return;
    active.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  };

  document.addEventListener("focusin", (event) => {
    if (!event.target?.matches?.("input, textarea, select")) return;
    setTimeout(revealActiveControl, 150);
    setTimeout(revealActiveControl, 450);
  });
  globalThis.visualViewport?.addEventListener("resize", revealActiveControl, {
    passive: true,
  });
  runtime.webApp.onEvent?.("viewportChanged", revealActiveControl);
}

function formatEntryCount(count) {
  if (getLanguage() === "en") return `${count} ${count === 1 ? "entry" : "entries"}`;
  const mod100 = count % 100;
  const mod10 = count % 10;
  const noun = mod100 >= 11 && mod100 <= 14 ? "записей" : mod10 === 1 ? "запись" : mod10 >= 2 && mod10 <= 4 ? "записи" : "записей";
  return `${count} ${noun}`;
}

function formatRelativeDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const day = 86_400_000;
  const difference = Math.round((startOfDay(date) - startOfDay(today)) / day);
  if (difference === 0) return t("сегодня");
  if (difference === -1) return t("вчера");
  return new Intl.DateTimeFormat(getLocale(), { day: "numeric", month: "short" }).format(date);
}

function formatFullDate(timestamp) {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function boot() {
  initializeLanguage(globalThis);
  initializeTheme(globalThis);
  renderLoading();
  bindGlobalInteractions();

  try {
    runtime = await initializeVaultRuntime(globalThis);
  } catch (error) {
    const launchedByTelegram = Boolean(globalThis.Telegram?.WebApp?.initData);
    if (launchedByTelegram || !isPreviewLocation()) {
      renderScreen("unsupported");
      return;
    }
    runtime = await initializePreviewRuntime();
  }

  document.body.classList.add(`runtime-${runtime.mode}`);
  controller = new VaultAppController({ persistence: runtime.persistence });
  controller.subscribe((state) => renderScreen(state.screen));
  bindLifecycle();
  bindKeyboardAvoidance();

  if (runtime.mode === "preview") {
    globalThis.__POCKET_VAULT_PREVIEW__ = { controller, webApp: runtime.webApp };
  } else {
    runtime.webApp.ready?.();
    runtime.webApp.expand?.();
  }

  try {
    await controller.initialize();
  } catch (error) {
    if (error?.code !== "unsupported_storage") showError(error);
    renderScreen("unsupported");
  }
}

void boot();
