const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  docs: [],
  connecting: false,
  queryInputMode: "builder",
  terminal: {
    running: false,
    history: [],
    historyIndex: -1,
  },
};

const comboState = {
  db: { options: [], filtered: [], open: false, highlighted: -1 },
  collection: { options: [], filtered: [], open: false, highlighted: -1 },
};

const querySelectState = {
  viewMode: { open: false },
  exportFormat: { open: false },
};

const SIDEBAR_COLLAPSE_STORAGE_KEY = "mongodb_admin_sidebar_collapsed";
const QUERY_INPUT_MODE_STORAGE_KEY = "mongodb_admin_query_input_mode";

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.style.background = isError ? "#6b2a23" : "#1f1b18";
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

function isDesktopViewport() {
  return window.matchMedia("(min-width: 1061px)").matches;
}

function getSavedSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function updateSidebarToggleButton(isCollapsed, isDesktop = true) {
  const button = $("sidebarToggleBtn");
  if (!button) {
    return;
  }

  if (!isDesktop) {
    button.setAttribute("aria-label", "折叠侧边栏（仅 PC）");
    button.title = "折叠侧边栏（仅 PC）";
    return;
  }

  const label = isCollapsed ? "展开侧边栏" : "折叠侧边栏";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function applySidebarCollapsed(collapsed, { persist = true } = {}) {
  const desktop = isDesktopViewport();
  const applied = desktop && Boolean(collapsed);
  document.body.classList.toggle("sidebar-collapsed", applied);
  updateSidebarToggleButton(applied, desktop);

  if (persist) {
    saveSidebarCollapsed(Boolean(collapsed));
  }
}

function initSidebarCollapseState() {
  applySidebarCollapsed(getSavedSidebarCollapsed(), { persist: false });
  window.addEventListener("resize", () => {
    applySidebarCollapsed(getSavedSidebarCollapsed(), { persist: false });
  });
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function parseEjsonDate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("$date" in value)) {
    return null;
  }

  const raw = value.$date;
  if (typeof raw === "string" || typeof raw === "number") {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof raw.$numberLong === "string"
  ) {
    const date = new Date(Number(raw.$numberLong));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function formatDateForDisplay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}:${sec}`;
}

function toDisplayValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => toDisplayValue(item));
  }

  const asDate = parseEjsonDate(value);
  if (asDate) {
    return formatDateForDisplay(asDate);
  }

  if (value && typeof value === "object") {
    const output = {};
    Object.entries(value).forEach(([key, inner]) => {
      output[key] = toDisplayValue(inner);
    });
    return output;
  }

  return value;
}

function stringifyValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function compact(value, max = 80) {
  const raw = stringifyValue(value);
  if (!raw) {
    return "";
  }
  return raw.length > max ? `${raw.slice(0, max)}...` : raw;
}

function readIdValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.$oid === "string"
  ) {
    return value.$oid;
  }
  return stringifyValue(value);
}

function shortIdValue(value, size = 18) {
  if (value.length <= size) {
    return value;
  }
  const keep = Math.max(6, Math.floor((size - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

async function copyText(text) {
  if (!text) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  }
}

function createIdFoldElement(idValue) {
  const fullId = readIdValue(idValue);
  if (!fullId) {
    return null;
  }

  const details = document.createElement("details");
  details.className = "id-fold";

  const summary = document.createElement("summary");
  summary.className = "id-summary";
  summary.title = "点击可复制 _id";

  const short = document.createElement("span");
  short.className = "id-short";
  short.textContent = fullId.slice(-5);

  summary.appendChild(short);
  summary.addEventListener("click", async () => {
    const copied = await copyText(fullId);
    showToast(copied ? "_id 已复制" : "复制失败", !copied);
  });

  const full = document.createElement("pre");
  full.className = "id-full";
  full.textContent = fullId;

  details.appendChild(summary);
  details.appendChild(full);
  return details;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  let payload = {};
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json();
  }

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败: ${response.status}`);
  }

  return payload;
}

function setStatus(status) {
  state.status = status;

  renderStatusChip(status);
  renderTerminalContext();
  $("statusText").textContent = formatJson(status);
  updateConnectToggle(status);
}

function renderStatusChip(status) {
  const chip = $("statusChip");
  if (!chip) {
    return;
  }

  if (state.connecting) {
    chip.textContent = "连接中...";
    chip.classList.remove("connected");
    chip.classList.add("connecting");
    return;
  }

  chip.classList.remove("connecting");
  chip.textContent = status.connected
    ? `已连接: ${status.dbName || "(未选库)"} / ${status.collectionName || "(未选集合)"}`
    : "未连接";
  chip.classList.toggle("connected", status.connected);
}

function connectToggleIconPath(isConnected) {
  if (isConnected) {
    return {
      frame:
        "M10 7V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2v-3",
      arrow: "M15 12H3M7 8l-4 4 4 4",
    };
  }

  return {
    frame:
      "M10 7V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2v-3",
    arrow: "M3 12h12M9 8l4 4-4 4",
  };
}

function updateConnectToggle(status) {
  const button = $("connectToggleBtn");
  if (!button) {
    return;
  }

  if (state.connecting) {
    button.disabled = true;
    button.classList.remove("is-connected");
    button.classList.add("is-connecting");
    button.setAttribute("aria-label", "连接中");
    button.title = "连接中";
    button.innerHTML = `
      <svg class="spin" viewBox="0 0 24 24" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r="8"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          opacity="0.28"
        />
        <path
          d="M20 12a8 8 0 0 0-8-8"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
    `;
    return;
  }

  const isConnected = Boolean(status?.connected);
  const icon = connectToggleIconPath(isConnected);
  button.disabled = false;
  button.classList.remove("is-connecting");
  button.classList.toggle("is-connected", isConnected);
  button.setAttribute("aria-label", isConnected ? "断开连接" : "连接数据库");
  button.title = isConnected ? "断开连接" : "连接数据库";
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="${icon.frame}"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="${icon.arrow}"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `;
}

function setConnecting(connecting) {
  state.connecting = Boolean(connecting);
  renderStatusChip(state.status || { connected: false, dbName: "", collectionName: "" });
  updateConnectToggle(state.status);
}

function getSavedQueryInputMode() {
  try {
    const value = localStorage.getItem(QUERY_INPUT_MODE_STORAGE_KEY);
    return value === "terminal" ? "terminal" : "builder";
  } catch {
    return "builder";
  }
}

function saveQueryInputMode(mode) {
  try {
    localStorage.setItem(QUERY_INPUT_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore storage failures
  }
}

function updateOperationTabbarVisibility() {
  const bar = document.querySelector(".operation-tabbar");
  if (!bar) {
    return;
  }
  const activeTab = document.querySelector(".tab.active")?.dataset.tab || "query";
  bar.hidden = activeTab === "query" && state.queryInputMode === "terminal";
}

function applyQueryInputMode(mode, { persist = true } = {}) {
  const nextMode = mode === "terminal" ? "terminal" : "builder";
  state.queryInputMode = nextMode;

  const queryTab = $("tab-query");
  const builderPanel = $("queryBuilderPanel");
  const terminalPanel = $("queryTerminalPanel");
  const builderBtn = $("queryBuilderModeBtn");
  const terminalBtn = $("queryTerminalModeBtn");

  if (queryTab) {
    queryTab.dataset.inputMode = nextMode;
  }
  if (builderPanel) {
    builderPanel.hidden = nextMode !== "builder";
  }
  if (terminalPanel) {
    terminalPanel.hidden = nextMode !== "terminal";
  }
  if (builderBtn) {
    builderBtn.classList.toggle("active", nextMode === "builder");
  }
  if (terminalBtn) {
    terminalBtn.classList.toggle("active", nextMode === "terminal");
  }

  updateOperationTabbarVisibility();

  if (persist) {
    saveQueryInputMode(nextMode);
  }
}

function terminalHostFromUri(uri) {
  if (!uri) {
    return "localhost:27017";
  }
  try {
    const parsed = new URL(uri);
    return parsed.host || "localhost:27017";
  } catch {
    return uri.replace(/^mongodb(\+srv)?:\/\//, "").split("/")[0] || "unknown";
  }
}

function renderTerminalContext() {
  const context = $("terminalContext");
  const prompt = $("terminalPrompt");
  if (!context || !prompt) {
    return;
  }

  const status = state.status || {};
  if (!status.connected) {
    context.textContent = "未连接";
    prompt.textContent = "db.(collection)>";
    return;
  }

  const host = terminalHostFromUri(status.uri);
  const dbName = status.dbName || "(未选库)";
  const collectionName = status.collectionName || "(未选集合)";
  context.textContent = `${host}  ·  ${dbName}  ·  ${collectionName}`;
  prompt.textContent = `${dbName}.${collectionName}>`;
}

function trimTerminalPayload(text, maxLength = 30000) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...（内容过长，已截断）`;
}

function appendTerminalEntry(type, message, payload = null) {
  const output = $("terminalOutput");
  if (!output) {
    return;
  }

  const entry = document.createElement("div");
  entry.className = `terminal-entry terminal-entry-${type}`;
  entry.textContent = message;

  if (payload !== null && payload !== undefined) {
    const pre = document.createElement("pre");
    pre.textContent = trimTerminalPayload(
      formatJson(toDisplayValue(payload)),
      30000,
    );
    entry.appendChild(pre);
  }

  output.appendChild(entry);
  output.scrollTop = output.scrollHeight;
}

function clearTerminalOutput() {
  const output = $("terminalOutput");
  if (!output) {
    return;
  }
  output.innerHTML = "";
}

function setTerminalRunning(running) {
  state.terminal.running = Boolean(running);
  const runButton = $("terminalRunBtn");
  const input = $("terminalInput");
  if (!runButton || !input) {
    return;
  }

  runButton.disabled = state.terminal.running;
  runButton.textContent = state.terminal.running ? "执行中..." : "执行";
  input.disabled = state.terminal.running;
}

function pushTerminalHistory(command) {
  if (!command) {
    return;
  }
  const list = state.terminal.history;
  if (list[list.length - 1] !== command) {
    list.push(command);
  }
  state.terminal.historyIndex = list.length;
}

function terminalResultSummary(data) {
  const elapsed = `${data.elapsedMs ?? 0}ms`;
  switch (data.resultType) {
    case "find":
      return `find => ${data.count} 条 (${elapsed})`;
    case "findOne":
      return `findOne => ${data.found ? "找到 1 条" : "未找到"} (${elapsed})`;
    case "countDocuments":
      return `countDocuments => ${data.count} (${elapsed})`;
    case "insertOne":
      return `insertOne => insertedId: ${JSON.stringify(data.insertedId)} (${elapsed})`;
    case "insertMany":
      return `insertMany => ${data.insertedCount} 条 (${elapsed})`;
    case "updateOne":
    case "updateMany":
      return `${data.resultType} => matched ${data.matchedCount}, modified ${data.modifiedCount} (${elapsed})`;
    case "deleteOne":
    case "deleteMany":
      return `${data.resultType} => deleted ${data.deletedCount} (${elapsed})`;
    default:
      return `执行完成 (${elapsed})`;
  }
}

function normalizeCommandResultForBottom(data) {
  return {
    resultType: data.resultType,
    elapsedMs: data.elapsedMs,
    count: data.count,
    found: data.found,
    insertedId: data.insertedId,
    insertedCount: data.insertedCount,
    insertedIds: data.insertedIds,
    matchedCount: data.matchedCount,
    modifiedCount: data.modifiedCount,
    upsertedCount: data.upsertedCount,
    deletedCount: data.deletedCount,
  };
}

function setActiveTab(target) {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === target);
  });
  document.querySelectorAll(".tab-content").forEach((section) => {
    section.classList.toggle("active", section.id === `tab-${target}`);
  });

  const modeSwitcher = $("queryModeSwitcher");
  if (modeSwitcher) {
    modeSwitcher.hidden = target !== "query";
  }

  updateOperationTabbarVisibility();
}

function activateTab(target) {
  setActiveTab(target);
}

function renderBottomCommandResult(title, payload) {
  activateTab("query");
  const meta = $("resultsMeta");
  const container = $("resultsContainer");
  if (!meta || !container) {
    return;
  }

  meta.textContent = title;
  container.innerHTML = "";

  const pre = document.createElement("pre");
  pre.className = "result-json";
  pre.textContent = formatJson(toDisplayValue(payload));
  container.appendChild(pre);
}

function syncUiByStatus(status) {
  if (!status) {
    return;
  }
  if (status.dbName) {
    $("dbComboInput").value = status.dbName;
  }
  if (status.collectionName) {
    $("collectionComboInput").value = status.collectionName;
  }
}

function getComboRefs(type) {
  if (type === "db") {
    return {
      input: $("dbComboInput"),
      menu: $("dbComboMenu"),
      toggle: $("dbComboToggleBtn"),
    };
  }
  return {
    input: $("collectionComboInput"),
    menu: $("collectionComboMenu"),
    toggle: $("collectionComboToggleBtn"),
  };
}

function filterComboOptions(type, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return comboState[type].options;
  }
  return comboState[type].options.filter((item) =>
    item.toLowerCase().includes(normalized),
  );
}

function renderComboMenu(type, query = "") {
  const refs = getComboRefs(type);
  const menu = refs.menu;
  const filtered = filterComboOptions(type, query);
  comboState[type].filtered = filtered;

  if (comboState[type].highlighted >= filtered.length) {
    comboState[type].highlighted = filtered.length ? 0 : -1;
  }

  menu.innerHTML = "";
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "combo-empty";
    empty.textContent = "无匹配项，可直接输入";
    menu.appendChild(empty);
    return;
  }

  filtered.forEach((value, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "combo-item";
    item.textContent = value;
    if (index === comboState[type].highlighted) {
      item.classList.add("active");
    }
    item.addEventListener("click", () => {
      refs.input.value = value;
      closeCombo(type);
    });
    menu.appendChild(item);
  });
}

function openCombo(type) {
  const refs = getComboRefs(type);
  comboState[type].open = true;
  refs.menu.hidden = false;
  refs.toggle.setAttribute("aria-expanded", "true");
  renderComboMenu(type, refs.input.value);
}

function closeCombo(type) {
  const refs = getComboRefs(type);
  comboState[type].open = false;
  comboState[type].highlighted = -1;
  refs.menu.hidden = true;
  refs.toggle.setAttribute("aria-expanded", "false");
}

function closeAllCombos(exceptType = null) {
  ["db", "collection"].forEach((type) => {
    if (type !== exceptType) {
      closeCombo(type);
    }
  });
}

function toggleCombo(type) {
  if (comboState[type].open) {
    closeCombo(type);
    return;
  }
  closeAllCombos(type);
  openCombo(type);
}

function moveComboHighlight(type, offset) {
  if (!comboState[type].open) {
    openCombo(type);
  }

  const options = comboState[type].filtered;
  if (!options.length) {
    return;
  }

  const current = comboState[type].highlighted;
  const next =
    current < 0
      ? offset > 0
        ? 0
        : options.length - 1
      : (current + offset + options.length) % options.length;
  comboState[type].highlighted = next;
  renderComboMenu(type, getComboRefs(type).input.value);
}

function setComboOptions(type, values, placeholder) {
  const refs = getComboRefs(type);
  refs.input.placeholder = placeholder;
  comboState[type].options = [...new Set(values.filter(Boolean))];
  comboState[type].highlighted = -1;
  renderComboMenu(type, refs.input.value);
}

function getQuerySelectRefs(type) {
  if (type === "viewMode") {
    return {
      root: $("viewModePicker"),
      input: $("viewMode"),
      button: $("viewModeBtn"),
      menu: $("viewModeMenu"),
      options: [...$("viewModeMenu").querySelectorAll(".theme-select-option")],
    };
  }

  return {
    root: $("exportFormatPicker"),
    input: $("exportFormat"),
    button: $("exportFormatBtn"),
    menu: $("exportFormatMenu"),
    options: [...$("exportFormatMenu").querySelectorAll(".theme-select-option")],
  };
}

function closeQuerySelect(type) {
  const refs = getQuerySelectRefs(type);
  querySelectState[type].open = false;
  refs.menu.hidden = true;
  refs.button.setAttribute("aria-expanded", "false");
}

function closeAllQuerySelects(exceptType = null) {
  ["viewMode", "exportFormat"].forEach((type) => {
    if (type !== exceptType) {
      closeQuerySelect(type);
    }
  });
}

function openQuerySelect(type) {
  const refs = getQuerySelectRefs(type);
  querySelectState[type].open = true;
  refs.menu.hidden = false;
  refs.button.setAttribute("aria-expanded", "true");
}

function setQuerySelectValue(type, value, { emitChange = true } = {}) {
  const refs = getQuerySelectRefs(type);
  const matched = refs.options.find((item) => item.dataset.value === value);
  if (!matched) {
    return;
  }

  refs.input.value = value;
  refs.button.querySelector(".theme-select-btn-label").textContent = matched.textContent.trim();
  refs.options.forEach((option) => {
    option.classList.toggle("active", option.dataset.value === value);
  });

  if (emitChange) {
    refs.input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function bindQuerySelect(type, onChange) {
  const refs = getQuerySelectRefs(type);

  refs.button.addEventListener("click", () => {
    if (querySelectState[type].open) {
      closeQuerySelect(type);
      return;
    }
    closeAllQuerySelects(type);
    openQuerySelect(type);
  });

  refs.options.forEach((option) => {
    option.addEventListener("click", () => {
      const value = option.dataset.value;
      setQuerySelectValue(type, value);
      closeQuerySelect(type);
      if (typeof onChange === "function") {
        onChange(value);
      }
    });
  });

  setQuerySelectValue(type, refs.input.value, { emitChange: false });
}

async function refreshStatus() {
  const data = await api("/api/status");
  setStatus(data.status);
}

async function refreshDatabases({ suppressError = false } = {}) {
  const dbInput = $("dbComboInput");
  if (!state.status?.connected) {
    setComboOptions("db", [], "先连接数据库");
    dbInput.value = "";
    return { warning: null };
  }
  try {
    const data = await api("/api/databases");
    setComboOptions(
      "db",
      data.databases.map((d) => d.name),
      "输入或选择数据库",
    );
    if (!dbInput.value && state.status?.dbName) {
      dbInput.value = state.status.dbName;
    }
    return { warning: data.warning || null };
  } catch (error) {
    setComboOptions("db", [], "手动输入数据库名");
    if (!suppressError) {
      throw error;
    }
    return { warning: error.message };
  }
}

async function refreshCollections({ suppressError = false } = {}) {
  const collectionInput = $("collectionComboInput");
  if (!state.status?.connected || !state.status?.dbName) {
    setComboOptions("collection", [], "先选择数据库");
    collectionInput.value = "";
    return { warning: null };
  }
  try {
    const data = await api("/api/collections");
    setComboOptions("collection", data.collections, "输入或选择集合");
    if (!collectionInput.value && state.status?.collectionName) {
      collectionInput.value = state.status.collectionName;
    }
    return { warning: data.warning || null };
  } catch (error) {
    setComboOptions("collection", [], "手动输入集合名");
    if (!suppressError) {
      throw error;
    }
    return { warning: error.message };
  }
}

function renderResults() {
  const container = $("resultsContainer");
  const docs = state.docs;
  const displayDocs = docs.map((doc) => toDisplayValue(doc));
  const mode = $("viewMode").value;
  const meta = $("resultsMeta");
  meta.textContent = `结果条数: ${docs.length}`;

  container.innerHTML = "";
  if (!docs.length) {
    container.innerHTML = '<p class="meta">没有匹配数据</p>';
    return;
  }

  if (mode === "json") {
    const pre = document.createElement("pre");
    pre.className = "result-json";
    pre.textContent = formatJson(displayDocs);
    container.appendChild(pre);
    return;
  }

  if (mode === "cards") {
    const grid = document.createElement("div");
    grid.className = "card-grid";
    docs.forEach((doc, index) => {
      const card = document.createElement("article");
      card.className = "doc-card";
      const title = document.createElement("h3");
      title.textContent = `Document #${index + 1}`;
      const idFold = createIdFoldElement(doc?._id);
      const pre = document.createElement("pre");
      pre.textContent = formatJson(displayDocs[index]);
      card.appendChild(title);
      if (idFold) {
        card.appendChild(idFold);
      }
      card.appendChild(pre);
      grid.appendChild(card);
    });
    container.appendChild(grid);
    return;
  }

  const columns = new Set(["_id"]);
  docs.slice(0, 30).forEach((doc) => {
    Object.keys(doc).forEach((key) => {
      if (columns.size < 10) {
        columns.add(key);
      }
    });
  });

  const keys = [...columns];
  const table = document.createElement("table");
  table.className = "result-table";
  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  keys.forEach((k) => {
    const th = document.createElement("th");
    th.textContent = k;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  docs.forEach((doc, index) => {
    const tr = document.createElement("tr");
    keys.forEach((k) => {
      const td = document.createElement("td");
      if (k === "_id") {
        const idFold = createIdFoldElement(doc[k]);
        if (idFold) {
          td.appendChild(idFold);
        }
      } else {
        td.textContent = compact(displayDocs[index]?.[k], 120);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function readQueryPayload() {
  return {
    filter: $("queryFilter").value.trim(),
    projection: $("queryProjection").value.trim(),
    sort: $("querySort").value.trim(),
    limit: Number($("queryLimit").value || 20),
  };
}

async function connectUsingCurrentInput() {
  const uri = $("uriInput").value.trim();
  const data = await api("/api/connect", {
    method: "POST",
    body: JSON.stringify({ uri }),
  });
  setStatus(data.status);
  if (data.status?.uri) {
    $("uriInput").value = data.status.uri;
  }
  const dbResult = await refreshDatabases({ suppressError: true });
  const collectionResult = await refreshCollections({ suppressError: true });

  const notices = [];
  if (data.adapted && data.adaptationReason) {
    notices.push(`已自动适配参数（${data.adaptationReason}）`);
  }
  const warnings = [dbResult.warning, collectionResult.warning].filter(Boolean);
  if (warnings.length) {
    notices.push(`部分列表不可见：${warnings[0]}`);
  }

  if (notices.length) {
    showToast(`连接成功，${notices.join("；")}`);
    return;
  }

  showToast("连接成功");
}

async function handleConnect(event) {
  event.preventDefault();
  if (state.connecting) {
    return;
  }
  setConnecting(true);
  try {
    await connectUsingCurrentInput();
  } finally {
    setConnecting(false);
  }
}

async function handleDisconnect() {
  const data = await api("/api/disconnect", { method: "POST", body: "{}" });
  setStatus(data.status);
  setComboOptions("db", [], "先连接数据库");
  setComboOptions("collection", [], "先选择数据库");
  $("dbComboInput").value = "";
  $("collectionComboInput").value = "";
  closeAllCombos();
  state.docs = [];
  renderResults();
  showToast("已断开连接");
}

async function handleConnectToggle() {
  if (state.status?.connected) {
    await handleDisconnect();
    return;
  }
  if (state.connecting) {
    return;
  }
  setConnecting(true);
  try {
    await connectUsingCurrentInput();
  } finally {
    setConnecting(false);
  }
}

async function handleSetDb() {
  const dbName = $("dbComboInput").value.trim();
  if (!dbName) {
    throw new Error("请输入或选择数据库名");
  }
  const data = await api("/api/database", {
    method: "POST",
    body: JSON.stringify({ dbName }),
  });
  setStatus(data.status);
  $("dbComboInput").value = dbName;
  setComboOptions("collection", data.collections, "输入或选择集合");
  $("collectionComboInput").value = "";
  closeCombo("db");
  if (data.warning) {
    showToast(data.warning);
    return;
  }
  showToast(`数据库已切换: ${dbName}`);
}

async function handleSetCollection() {
  const collectionName = $("collectionComboInput").value.trim();
  if (!collectionName) {
    throw new Error("请输入或选择集合名");
  }
  const data = await api("/api/collection", {
    method: "POST",
    body: JSON.stringify({ collectionName }),
  });
  setStatus(data.status);
  $("collectionComboInput").value = collectionName;
  closeCombo("collection");
  showToast(`集合已切换: ${collectionName}`);
}

async function handleQuery() {
  const payload = readQueryPayload();
  const data = await api("/api/query", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.docs = data.docs;
  renderResults();
  showToast(`查询完成: ${data.count} 条`);
}

async function handleInsert() {
  const doc = $("insertDoc").value.trim();
  const data = await api("/api/insert", {
    method: "POST",
    body: JSON.stringify({ doc }),
  });
  showToast(`插入成功: ${JSON.stringify(data.insertedId)}`);
}

async function handleUpdate() {
  const data = await api("/api/update", {
    method: "POST",
    body: JSON.stringify({
      filter: $("updateFilter").value.trim(),
      update: $("updateDoc").value.trim(),
      many: $("updateMany").checked,
      upsert: $("updateUpsert").checked,
    }),
  });
  showToast(`更新完成: matched ${data.matchedCount}, modified ${data.modifiedCount}`);
}

async function handleDelete() {
  const accepted = window.confirm("确认执行删除操作？");
  if (!accepted) {
    return;
  }
  const data = await api("/api/delete", {
    method: "POST",
    body: JSON.stringify({
      filter: $("deleteFilter").value.trim(),
      many: $("deleteMany").checked,
    }),
  });
  showToast(`删除完成: ${data.deletedCount} 条`);
}

async function handleStats() {
  const data = await api("/api/stats");
  $("statsOutput").textContent = formatJson(data.stats);
  showToast("统计已刷新");
}

async function handleExport() {
  const payload = {
    ...readQueryPayload(),
    format: $("exportFormat").value,
  };

  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = `导出失败: ${response.status}`;
    try {
      const json = await response.json();
      message = json.error || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const fileNameMatch = disposition.match(/filename="(.+)"/);
  const fileName = fileNameMatch?.[1] || `export_${Date.now()}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`导出成功: ${fileName}`);
}

async function executeTerminalCommand() {
  const input = $("terminalInput");
  const command = input.value.trim();
  if (!command || state.terminal.running) {
    return;
  }

  appendTerminalEntry("cmd", `> ${command}`);
  pushTerminalHistory(command);
  input.value = "";

  setTerminalRunning(true);
  try {
    const data = await api("/api/command", {
      method: "POST",
      body: JSON.stringify({ command }),
    });

    if (data.status) {
      setStatus(data.status);
      syncUiByStatus(data.status);
      await refreshCollections({ suppressError: true });
    }

    if (data.resultType === "find") {
      state.docs = data.docs || [];
      renderResults();
    } else if (data.resultType === "findOne") {
      state.docs = data.doc ? [data.doc] : [];
      renderResults();
    } else {
      renderBottomCommandResult(
        terminalResultSummary(data),
        normalizeCommandResultForBottom(data),
      );
    }

    const summary = terminalResultSummary(data);
    showToast(summary);
  } catch (error) {
    renderBottomCommandResult("命令执行失败", { command, error: error.message });
    showToast(error.message, true);
  } finally {
    setTerminalRunning(false);
    input.focus();
  }
}

function setupTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      setActiveTab(target);
    });
  });
}

function bindEvents() {
  const runSetDb = wrap(handleSetDb);
  const runSetCollection = wrap(handleSetCollection);

  $("connectForm").addEventListener("submit", wrap(handleConnect));
  $("sidebarToggleBtn").addEventListener("click", () => {
    if (!isDesktopViewport()) {
      return;
    }
    const next = !document.body.classList.contains("sidebar-collapsed");
    applySidebarCollapsed(next);
  });
  $("connectToggleBtn").addEventListener("click", wrap(handleConnectToggle));
  $("refreshDbBtn").addEventListener("click", wrap(refreshDatabases));
  $("refreshCollectionBtn").addEventListener("click", wrap(refreshCollections));
  $("setDbBtn").addEventListener("click", runSetDb);
  $("setCollectionBtn").addEventListener("click", runSetCollection);

  $("dbComboInput").addEventListener("focus", () => {
    closeAllCombos("db");
    openCombo("db");
  });
  $("dbComboInput").addEventListener("input", (event) => {
    closeAllCombos("db");
    openCombo("db");
    comboState.db.highlighted = -1;
    renderComboMenu("db", event.target.value);
  });
  $("dbComboInput").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveComboHighlight("db", 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveComboHighlight("db", -1);
      return;
    }
    if (event.key === "Escape") {
      closeCombo("db");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (comboState.db.open && comboState.db.highlighted >= 0) {
        const value = comboState.db.filtered[comboState.db.highlighted];
        if (value) {
          $("dbComboInput").value = value;
        }
        closeCombo("db");
        return;
      }
      runSetDb();
    }
  });
  $("dbComboToggleBtn").addEventListener("click", (event) => {
    event.preventDefault();
    closeAllCombos("db");
    toggleCombo("db");
    $("dbComboInput").focus();
  });

  $("collectionComboInput").addEventListener("focus", () => {
    closeAllCombos("collection");
    openCombo("collection");
  });
  $("collectionComboInput").addEventListener("input", (event) => {
    closeAllCombos("collection");
    openCombo("collection");
    comboState.collection.highlighted = -1;
    renderComboMenu("collection", event.target.value);
  });
  $("collectionComboInput").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveComboHighlight("collection", 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveComboHighlight("collection", -1);
      return;
    }
    if (event.key === "Escape") {
      closeCombo("collection");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (comboState.collection.open && comboState.collection.highlighted >= 0) {
        const value = comboState.collection.filtered[comboState.collection.highlighted];
        if (value) {
          $("collectionComboInput").value = value;
        }
        closeCombo("collection");
        return;
      }
      runSetCollection();
    }
  });
  $("collectionComboToggleBtn").addEventListener("click", (event) => {
    event.preventDefault();
    closeAllCombos("collection");
    toggleCombo("collection");
    $("collectionComboInput").focus();
  });

  document.addEventListener("click", (event) => {
    const dbField = $("dbComboInput").closest(".combo-field");
    const collectionField = $("collectionComboInput").closest(".combo-field");
    const viewSelectRoot = $("viewModePicker");
    const exportSelectRoot = $("exportFormatPicker");
    if (!dbField.contains(event.target)) {
      closeCombo("db");
    }
    if (!collectionField.contains(event.target)) {
      closeCombo("collection");
    }
    if (!viewSelectRoot.contains(event.target)) {
      closeQuerySelect("viewMode");
    }
    if (!exportSelectRoot.contains(event.target)) {
      closeQuerySelect("exportFormat");
    }
  });

  $("runQueryBtn").addEventListener("click", wrap(handleQuery));
  bindQuerySelect("viewMode");
  bindQuerySelect("exportFormat");
  $("queryBuilderModeBtn").addEventListener("click", () => {
    applyQueryInputMode("builder");
  });
  $("queryTerminalModeBtn").addEventListener("click", () => {
    applyQueryInputMode("terminal");
    $("terminalInput").focus();
  });
  $("viewMode").addEventListener("change", renderResults);
  $("exportBtn").addEventListener("click", wrap(handleExport));

  $("insertBtn").addEventListener("click", wrap(handleInsert));
  $("updateBtn").addEventListener("click", wrap(handleUpdate));
  $("deleteBtn").addEventListener("click", wrap(handleDelete));
  $("statsBtn").addEventListener("click", wrap(handleStats));

  $("terminalRunBtn").addEventListener("click", () => {
    void executeTerminalCommand();
  });
  $("terminalClearBtn").addEventListener("click", () => {
    clearTerminalOutput();
  });
  $("terminalInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void executeTerminalCommand();
      return;
    }

    if (event.key === "ArrowUp") {
      const history = state.terminal.history;
      if (!history.length) {
        return;
      }
      event.preventDefault();
      if (state.terminal.historyIndex > 0) {
        state.terminal.historyIndex -= 1;
      } else {
        state.terminal.historyIndex = 0;
      }
      $("terminalInput").value = history[state.terminal.historyIndex] || "";
      return;
    }

    if (event.key === "ArrowDown") {
      const history = state.terminal.history;
      if (!history.length) {
        return;
      }
      event.preventDefault();
      if (state.terminal.historyIndex < history.length - 1) {
        state.terminal.historyIndex += 1;
        $("terminalInput").value = history[state.terminal.historyIndex] || "";
      } else {
        state.terminal.historyIndex = history.length;
        $("terminalInput").value = "";
      }
    }
  });
}

function wrap(fn) {
  return async (...args) => {
    try {
      await fn(...args);
      await refreshStatus();
    } catch (error) {
      showToast(error.message, true);
    }
  };
}

async function init() {
  setupTabs();
  const activeTab = document.querySelector(".tab.active")?.dataset.tab || "query";
  setActiveTab(activeTab);
  initSidebarCollapseState();
  bindEvents();
  applyQueryInputMode(getSavedQueryInputMode(), { persist: false });
  renderTerminalContext();
  setTerminalRunning(false);
  await refreshStatus();
  await refreshDatabases({ suppressError: true });
  await refreshCollections({ suppressError: true });
  renderResults();
}

init().catch((error) => showToast(error.message, true));
