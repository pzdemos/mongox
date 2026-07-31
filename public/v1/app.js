const API_BASE = "/mongo";

const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  docs: [],
  connections: [],
  connecting: false,
  editingConnectionId: null,
  queryInputMode: "builder",
  queryInputCollapsed: false,
  loading: {
    query: false,
    insert: false,
    update: false,
    delete: false,
    databases: false,
    collections: false,
  },
  terminal: {
    running: false,
    history: [],
    historyIndex: -1,
  },
  tree: {
    databases: [],
    expandedDbs: new Set(),
    collectionsMap: {},
    busy: false,
    searchKeyword: "",
    searchMatches: [],
    searchTruncated: false,
    searching: false,
    searchToken: 0,
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
const QUERY_INPUT_COLLAPSED_STORAGE_KEY = "mongodb_admin_query_input_collapsed";

function activeConnectionId() {
  return state.status?.activeConnectionId || null;
}

function findSavedConnection(connectionId) {
  return state.connections.find((item) => item.id === connectionId) || null;
}

function findLatestConnectionOfType(type) {
  const matches = state.connections.filter((item) => (item.type || "mongo") === type);
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const at = a.lastUsedAt || a.createdAt || "";
    const bt = b.lastUsedAt || b.createdAt || "";
    return bt.localeCompare(at);
  });
  return matches[0];
}

function editingConnection() {
  return findSavedConnection(state.editingConnectionId);
}

const DEFAULT_URIS = {
  mongo: "mongodb://127.0.0.1:27017/mydb",
  postgres: "postgresql://postgres:password@127.0.0.1:5432/mydb",
  mysql: "mysql://root:password@127.0.0.1:3306/mydb",
};

const URI_PLACEHOLDERS = {
  mongo: "mongodb://用户名:密码@主机:27018/库名",
  postgres: "postgresql://用户名:密码@主机:15432/库名",
  mysql: "mysql://用户名:密码@主机:13306/库名",
};

function readConnectionDraft() {
  return {
    name: $("connectionNameInput")?.value.trim() || "",
    type: $("connectionTypeInput")?.value || "mongo",
    uri: $("uriInput")?.value.trim() || "",
  };
}

function applyConnectionDraft(connection) {
  $("connectionNameInput").value = connection?.name || "";
  const type = connection?.type || "mongo";
  if ($("connectionTypeInput")) $("connectionTypeInput").value = type;
  $("uriInput").value = connection?.uri || "";
  applyUriPlaceholder(type);
}

function applyUriPlaceholder(type) {
  const input = $("uriInput");
  if (!input) return;
  input.placeholder = URI_PLACEHOLDERS[type] || URI_PLACEHOLDERS.mongo;
}

function clearConnectionDraft() {
  applyConnectionDraft({ name: "", type: "mongo", uri: DEFAULT_URIS.mongo });
}

function draftMatchesConnection(connection = editingConnection()) {
  if (!connection) {
    return false;
  }
  const draft = readConnectionDraft();
  return (
    draft.name === (connection.name || "") &&
    draft.uri === (connection.uri || "") &&
    draft.type === (connection.type || "mongo")
  );
}

function findSavedConnectionByUri(uri) {
  const normalized = String(uri || "").trim();
  if (!normalized) {
    return null;
  }
  return state.connections.find((item) => item.uri === normalized) || null;
}

function getDraftContext() {
  const draft = readConnectionDraft();
  const editing = editingConnection();
  const activeId = activeConnectionId();
  const active = findSavedConnection(activeId);

  let boundConnection = null;
  if (editing && draft.uri === (editing.uri || "")) {
    boundConnection = editing;
  } else {
    boundConnection = findSavedConnectionByUri(draft.uri);
  }

  const exactMatch = Boolean(
    boundConnection &&
      draft.uri === (boundConnection.uri || "") &&
      draft.name === (boundConnection.name || ""),
  );
  const affectsActive = Boolean(boundConnection?.id && boundConnection.id === activeId);
  const canDisconnectActive = Boolean(state.status?.connected && affectsActive && exactMatch);
  const isNewDraft = Boolean(draft.uri) && !boundConnection;

  return {
    draft,
    editing,
    active,
    boundConnection,
    exactMatch,
    affectsActive,
    canDisconnectActive,
    isNewDraft,
  };
}

function showToast(message, isError = false, { duration = 2600, detail = "" } = {}) {
  const toast = $("toast");
  toast.textContent = detail ? `${message}\n${detail}` : message;
  toast.style.background = isError ? "#6b2a23" : "#1f1b18";
  toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove("show"), duration);
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

function updateSidebarToggleButton(isCollapsed) {
  const button = $("sidebarToggleBtn");
  if (!button) {
    return;
  }

  const label = isCollapsed ? "展开侧边栏" : "折叠侧边栏";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function isMobile() {
  return window.innerWidth <= 1060;
}

function applySidebarCollapsed(collapsed, { persist = true } = {}) {
  const applied = Boolean(collapsed);
  document.body.classList.toggle("sidebar-collapsed", applied);
  updateSidebarToggleButton(applied);

  // Mobile backdrop toggle
  const backdrop = $("sidebarBackdrop");
  if (backdrop && isMobile()) {
    backdrop.classList.toggle("visible", !applied);
  }

  if (persist) {
    saveSidebarCollapsed(Boolean(collapsed));
  }
}

function initSidebarCollapseState() {
  // Mobile: default collapsed
  const saved = getSavedSidebarCollapsed();
  const mobile = isMobile();
  applySidebarCollapsed(mobile ? true : saved, { persist: false });
  window.addEventListener("resize", () => {
    const isNowMobile = isMobile();
    applySidebarCollapsed(isNowMobile ? true : getSavedSidebarCollapsed(), { persist: false });
  });
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function highlightJson(jsonStr) {
  const tokenRegex =
    /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = tokenRegex.exec(jsonStr)) !== null) {
    result += escapeHtml(jsonStr.slice(lastIndex, match.index));
    if (match[1]) {
      result += `<span class="json-key">${escapeHtml(match[1])}</span>${escapeHtml(match[2])}`;
    } else if (match[3]) {
      result += `<span class="json-string">${escapeHtml(match[3])}</span>`;
    } else if (match[4]) {
      result += `<span class="json-num">${escapeHtml(match[4])}</span>`;
    } else if (match[5]) {
      result += `<span class="json-bool">${escapeHtml(match[5])}</span>`;
    }
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(jsonStr.slice(lastIndex));
  return result;
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

function parseEjsonNumber(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if ("$numberInt" in value) return Number(value.$numberInt);
  if ("$numberLong" in value) return Number(value.$numberLong);
  if ("$numberDouble" in value) return Number(value.$numberDouble);
  if ("$numberDecimal" in value) return value.$numberDecimal;
  return undefined;
}

function toDisplayValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => toDisplayValue(item));
  }

  const asDate = parseEjsonDate(value);
  if (asDate) {
    return formatDateForDisplay(asDate);
  }

  const asNumber = parseEjsonNumber(value);
  if (asNumber !== undefined) {
    return asNumber;
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

async function api(url, options = {}, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      ...options,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error("请求超时");
      e.timeout = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let payload = {};
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json();
  }

  if (!response.ok || payload.ok === false) {
    const e = new Error(payload.error || `请求失败: ${response.status}`);
    e.payload = payload;
    throw e;
  }

  return payload;
}

async function runWithLoading(key, buttonId, busyText, fn) {
  if (state.loading[key]) return;
  state.loading[key] = true;
  const btn = $(buttonId);
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.dataset.originalText = originalText;
    btn.textContent = busyText;
  }
  try {
    return await fn();
  } finally {
    state.loading[key] = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
      delete btn.dataset.originalText;
    }
  }
}

function setStatus(status) {
  state.status = status;

  renderStatusChip(status);
  renderTerminalContext();
  updateConnectToggle(status);
  renderConnectionList();
  applyDriverTypeToForms(status?.driverType || "mongo");
}

function applyDriverTypeToForms(type) {
  const isSql = type === "postgres" || type === "mysql";

  const labelMap = [
    { id: "queryFilter", sql: "WHERE 子句（可空）", mongo: "Filter (JSON/EJSON)" },
    { id: "queryProjection", sql: "查询字段（逗号分隔，可空）", mongo: "Projection (JSON/EJSON, 可选)" },
    { id: "querySort", sql: "ORDER BY（可空，如 id DESC）", mongo: "Sort (JSON/EJSON, 可选)" },
    { id: "insertDoc", sql: "行数据 (JSON 对象，列名→值)", mongo: "Document (JSON/EJSON)" },
    { id: "updateFilter", sql: "WHERE 条件", mongo: "Filter (JSON/EJSON)" },
    { id: "updateDoc", sql: "SET (JSON，列名→值)", mongo: "Update (JSON/EJSON)" },
    { id: "deleteFilter", sql: "WHERE 条件", mongo: "Filter (JSON/EJSON)" },
  ];

  // Mongo → SQL 切换时，把残留的 Mongo 占位符（{} / 空对象）清掉，避免拼出 WHERE {} 语法错
  const MONGO_PLACEHOLDER_VALUES = new Set(["{}", "[]", ""]);
  const MONGO_DEFAULT_DOC = `{
  "name": "demo",
  "createdAt": {"$date":"2026-01-01T00:00:00Z"}
}`;
  const MONGO_DEFAULT_UPDATE = `{
  "$set": {
    "updatedAt": {"$date":"2026-01-01T00:00:00Z"}
  }
}`;
  const fieldsToClear = ["queryFilter", "queryProjection", "querySort", "updateFilter"];

  labelMap.forEach(({ id, sql, mongo }) => {
    const input = $(id);
    if (!input) return;
    const label = input.closest("label");
    if (label && label.firstChild && label.firstChild.nodeType === Node.TEXT_NODE) {
      label.firstChild.textContent = isSql ? sql : mongo;
    }
    if (id === "queryFilter") input.placeholder = isSql ? "例如：id > 100 AND status = 'active'" : "{}";
    if (id === "querySort") input.placeholder = isSql ? "例如：created_at DESC" : "";

    if (isSql && fieldsToClear.includes(id) && MONGO_PLACEHOLDER_VALUES.has(input.value.trim())) {
      input.value = "";
    }
    if (isSql && id === "insertDoc" && input.value.trim() === MONGO_DEFAULT_DOC.trim()) {
      input.value = `{
  "name": "demo",
  "created_at": {"__sql.date": "2026-01-01T00:00:00Z"}
}`;
    }
    if (isSql && id === "updateDoc" && input.value.trim() === MONGO_DEFAULT_UPDATE.trim()) {
      input.value = `{
  "name": "updated",
  "updated_at": {"__sql.date": "2026-01-01T00:00:00Z"}
}`;
    }
    if (isSql && id === "deleteFilter" && MONGO_PLACEHOLDER_VALUES.has(input.value.trim())) {
      input.value = "";
    }
  });

  const termInput = $("terminalInput");
  if (termInput) {
    termInput.placeholder = isSql ? "SELECT * FROM users LIMIT 10" : "db.getCollection('temp').find({})";
  }
}

function clearWorkspaceState() {
  state.tree.databases = [];
  state.tree.collectionsMap = {};
  state.tree.expandedDbs.clear();
  state.docs = [];
  renderDbTree();
  renderResults();
}

async function loadConnectionResources() {
  if (!state.status?.connected) {
    clearWorkspaceState();
    return;
  }

  await Promise.all([
    refreshDatabases({ suppressError: true }),
    refreshCollections({ suppressError: true }),
  ]);
}

function closeIndexContextMenu() {
  const menu = $("indexContextMenu");
  if (menu) menu.hidden = true;
}

const contextMenuState = { dbName: "", colName: "", activeTab: "indexes" };

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "-";
  const n = Number(bytes);
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatCount(num) {
  if (num == null || Number.isNaN(Number(num))) return "-";
  return Number(num).toLocaleString("en-US");
}

async function showIndexContextMenu(dbName, colName, x, y) {
  const menu = $("indexContextMenu");
  const title = $("indexContextMenuTitle");
  const body = $("indexContextMenuBody");
  if (!menu || !title || !body) return;

  contextMenuState.dbName = dbName;
  contextMenuState.colName = colName;
  contextMenuState.activeTab = "indexes";

  title.textContent = colName;
  menu.querySelectorAll(".context-menu-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.cmTab === "indexes");
  });

  body.innerHTML = '<div class="context-menu-loading">加载中...</div>';

  menu.hidden = false;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
  });

  await loadContextMenuTab("indexes");
}

async function loadContextMenuTab(tab) {
  const body = $("indexContextMenuBody");
  if (!body) return;
  contextMenuState.activeTab = tab;

  body.innerHTML = '<div class="context-menu-loading">加载中...</div>';

  try {
    if (tab === "indexes") {
      await renderContextMenuIndexes(body);
    } else if (tab === "stats") {
      await renderContextMenuStats(body);
    }
  } catch (error) {
    body.innerHTML = `<div class="context-menu-error">${escapeHtml(error.message)}</div>`;
  }

  requestAnimationFrame(clampContextMenuPosition);
}

function clampContextMenuPosition() {
  const menu = $("indexContextMenu");
  if (!menu || menu.hidden) return;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
  }
  if (rect.bottom > window.innerHeight - 8) {
    menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
  }
}

async function renderContextMenuIndexes(body) {
  const { dbName, colName } = contextMenuState;
  const data = await api(
    `${API_BASE}/api/indexes?dbName=${encodeURIComponent(dbName)}&collectionName=${encodeURIComponent(colName)}`,
  );
  const indexes = data.indexes || [];
  body.innerHTML = "";

  if (!indexes.length) {
    body.innerHTML = '<div class="context-menu-empty">无索引</div>';
    return;
  }

  indexes.forEach((idx) => {
    const item = document.createElement("div");
    item.className = "context-menu-item";

    const nameEl = document.createElement("div");
    nameEl.className = "context-menu-item-name";
    nameEl.textContent = idx.name;

    const keyEl = document.createElement("div");
    keyEl.className = "context-menu-item-key";
    keyEl.textContent = JSON.stringify(idx.key);

    item.appendChild(nameEl);
    item.appendChild(keyEl);

    if (idx.unique || idx.sparse) {
      const tags = document.createElement("div");
      tags.className = "context-menu-item-tags";
      if (idx.unique) {
        const tag = document.createElement("span");
        tag.className = "context-menu-tag unique";
        tag.textContent = "unique";
        tags.appendChild(tag);
      }
      if (idx.sparse) {
        const tag = document.createElement("span");
        tag.className = "context-menu-tag sparse";
        tag.textContent = "sparse";
        tags.appendChild(tag);
      }
      item.appendChild(tags);
    }

    body.appendChild(item);
  });
}

async function renderContextMenuStats(body) {
  const { dbName, colName } = contextMenuState;
  const data = await api(
    `${API_BASE}/api/collection-stats?dbName=${encodeURIComponent(dbName)}&collectionName=${encodeURIComponent(colName)}`,
  );
  const s = data.stats || {};
  body.innerHTML = "";

  // 主要指标
  const primary = [
    { label: "文档数量", value: formatCount(s.accurateCount ?? s.estimatedCount) },
    { label: "数据大小", value: formatBytes(s.size) },
    { label: "存储大小", value: formatBytes(s.storageSize) },
    { label: "索引数量", value: formatCount(s.nIndexes) },
  ];
  body.appendChild(buildStatsGroup(primary));

  // 详细信息
  const detail = [
    { label: "平均文档大小", value: formatBytes(s.avgObjSize) },
    { label: "索引总大小", value: formatBytes(s.totalIndexSize) },
    { label: "空闲空间", value: s.freeStorageSize ? formatBytes(s.freeStorageSize) : "-" },
  ];
  body.appendChild(buildStatsGroup(detail, "详细信息"));

  // 索引大小
  const indexSizes = s.indexSizes || {};
  const indexEntries = Object.entries(indexSizes).map(([name, size]) => ({
    label: name,
    value: formatBytes(size),
  }));
  if (indexEntries.length) {
    body.appendChild(buildStatsGroup(indexEntries, "索引大小", true));
  }
}

function buildStatsGroup(entries, heading = null, monoLabel = false) {
  const group = document.createElement("div");
  group.className = "stats-group";

  if (heading) {
    const h = document.createElement("div");
    h.className = "stats-group-heading";
    h.textContent = heading;
    group.appendChild(h);
  }

  entries.forEach(({ label, value }) => {
    const row = document.createElement("div");
    row.className = "stats-row";

    const lab = document.createElement("span");
    lab.className = "stats-label" + (monoLabel ? " stats-label-mono" : "");
    lab.textContent = label;

    const val = document.createElement("span");
    val.className = "stats-value";
    val.textContent = value;

    row.appendChild(lab);
    row.appendChild(val);
    group.appendChild(row);
  });

  return group;
}

function renderConnectionList() {
  const container = $("connectionList");
  const meta = $("connectionMeta");
  if (!container || !meta) {
    return;
  }

  meta.textContent = `${state.connections.length} 个`;
  container.innerHTML = "";

  if (!state.connections.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "暂无连接配置";
    container.appendChild(empty);
    return;
  }

  const activeId = activeConnectionId();
  const draftBindingId = getDraftContext().boundConnection?.id || null;
  state.connections.forEach((connection) => {
    const item = document.createElement("article");
    item.className = "connection-item";
    if (connection.id === activeId) {
      item.classList.add("active");
    }
    if (connection.id === draftBindingId) {
      item.classList.add("editing");
    }

    item.addEventListener("click", () => {
      void handleConnectionSelect(connection.id);
    });

    const header = document.createElement("div");
    header.className = "connection-item-header";

    const title = document.createElement("div");
    title.className = "connection-item-title";
    title.textContent = connection.name || "未命名连接";

    const typeChip = document.createElement("span");
    typeChip.className = `driver-chip driver-chip-${connection.type || "mongo"}`;
    typeChip.textContent = (connection.type || "mongo").toUpperCase();

    const titleWrap = document.createElement("div");
    titleWrap.className = "connection-item-title-wrap";
    titleWrap.appendChild(title);
    titleWrap.appendChild(typeChip);

    const badge = document.createElement("span");
    badge.className = `connection-badge${connection.connected ? " connected" : ""}`;
    badge.textContent = connection.connected ? "在线" : "离线";

    header.appendChild(titleWrap);
    header.appendChild(badge);

    const uri = document.createElement("div");
    uri.className = "connection-item-uri";
    uri.textContent = connection.uriMasked || connection.uri || "";

    const isSql = connection.type === "postgres" || connection.type === "mysql";
    const metaLine = document.createElement("div");
    metaLine.className = "connection-item-meta";
    metaLine.textContent = `${connection.dbName || "未选库"} / ${
      connection.collectionName || (isSql ? "未选表" : "未选集合")
    }`;

    const actions = document.createElement("div");
    actions.className = "connection-item-actions";

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "ghost";
    useBtn.textContent = "编辑";
    useBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void handleConnectionSelect(connection.id);
    });

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.textContent = connection.connected ? "断开" : "连接";
    toggleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (connection.connected) {
        void handleDisconnectConnection(connection.id);
      } else {
        void handleConnectSavedConnection(connection.id);
      }
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "danger";
    deleteBtn.textContent = "删除";
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void handleDeleteConnection(connection.id);
    });

    actions.appendChild(useBtn);
    actions.appendChild(toggleBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(header);
    item.appendChild(uri);
    item.appendChild(metaLine);
    item.appendChild(actions);
    container.appendChild(item);
  });
}

function renderDbTree() {
  const container = $("dbTree");
  if (!container) return;

  container.innerHTML = "";

  if (state.tree.searchKeyword) {
    renderTreeSearchResults(container);
    return;
  }

  const databases = state.tree.databases;
  const currentDb = state.status?.dbName || "";
  const currentCol = state.status?.collectionName || "";

  if (!databases.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = state.status?.connected ? "暂无数据库" : "未连接";
    container.appendChild(empty);
    return;
  }

  databases.forEach((dbName) => {
    const item = document.createElement("div");
    item.className = "tree-item";

    const dbRow = document.createElement("div");
    dbRow.className = "tree-db" + (dbName === currentDb ? " active" : "");

    const arrow = document.createElement("span");
    arrow.className = "tree-db-arrow" + (state.tree.expandedDbs.has(dbName) ? " open" : "");
    arrow.textContent = "\u25B8";

    const name = document.createElement("span");
    name.className = "tree-db-name";
    name.textContent = dbName;

    dbRow.appendChild(arrow);
    dbRow.appendChild(name);

    dbRow.addEventListener("click", async () => {
      if (state.tree.busy) return;
      if (dbName === currentDb) {
        if (state.tree.expandedDbs.has(dbName)) {
          state.tree.expandedDbs.delete(dbName);
        } else {
          state.tree.expandedDbs.add(dbName);
        }
        renderDbTree();
        return;
      }

      state.tree.busy = true;
      try {
        const data = await api(`${API_BASE}/api/database`, {
          method: "POST",
          body: JSON.stringify({ dbName }),
        });
        setStatus(data.status);
        state.tree.expandedDbs.add(dbName);
        state.tree.collectionsMap[dbName] = data.collections || [];
        renderDbTree();
        showToast(`数据库已切换: ${dbName}`);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        state.tree.busy = false;
      }
      await refreshStatus();
    });

    item.appendChild(dbRow);

    if (state.tree.expandedDbs.has(dbName)) {
      const colList = document.createElement("div");
      colList.className = "tree-collections";
      const collections = state.tree.collectionsMap[dbName] || [];
      const isSql =
        state.status?.driverType === "postgres" || state.status?.driverType === "mysql";
      if (collections.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tree-empty";
        empty.textContent = isSql ? "无表" : "无集合";
        colList.appendChild(empty);
      } else {
        const driverType = state.status?.driverType || "mongo";
        const chipLabel = driverType === "postgres" ? "PG" : driverType === "mysql" ? "MS" : "MG";
        collections.forEach((colName) => {
          const colRow = document.createElement("div");
          colRow.className = "tree-collection" + (dbName === currentDb && colName === currentCol ? " active" : "");

          const chip = document.createElement("span");
          chip.className = `driver-chip driver-chip-${driverType}`;
          chip.textContent = chipLabel;
          chip.title = driverType === "postgres" ? "PostgreSQL" : driverType === "mysql" ? "MySQL/MariaDB" : "MongoDB";

          const nameSpan = document.createElement("span");
          nameSpan.className = "tree-collection-name";
          nameSpan.textContent = colName;

          colRow.appendChild(chip);
          colRow.appendChild(nameSpan);

          // Right-click: show index context menu
          colRow.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeIndexContextMenu();
            showIndexContextMenu(dbName, colName, e.clientX, e.clientY);
          });

          // Long-press (mobile): show index context menu
          let longPressTimer = null;
          colRow.addEventListener("touchstart", (e) => {
            const t = e.touches[0];
            longPressTimer = setTimeout(() => {
              e.preventDefault();
              closeIndexContextMenu();
              showIndexContextMenu(dbName, colName, t.clientX, t.clientY);
              longPressTimer = null;
            }, 500);
          }, { passive: false });
          colRow.addEventListener("touchend", () => {
            if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
          });
          colRow.addEventListener("touchmove", () => {
            if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
          });

          colRow.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (state.tree.busy) return;
            state.tree.busy = true;
            try {
              if (isMobile()) applySidebarCollapsed(true);

              if (dbName !== currentDb) {
                try {
                  const data = await api(`${API_BASE}/api/database`, {
                    method: "POST",
                    body: JSON.stringify({ dbName }),
                  });
                  setStatus(data.status);
                  state.tree.expandedDbs.add(dbName);
                  state.tree.collectionsMap[dbName] = data.collections || [];
                } catch (error) {
                  showToast(error.message, true);
                  return;
                }
              }
              try {
                const data = await api(`${API_BASE}/api/collection`, {
                  method: "POST",
                  body: JSON.stringify({ collectionName: colName }),
                });
                setStatus(data.status);
                renderDbTree();
                try {
                  const qData = await api(`${API_BASE}/api/query`, {
                    method: "POST",
                    body: JSON.stringify({ filter: "{}", limit: 20 }),
                  });
                  state.docs = qData.docs;
                  renderResults();
                } catch { /* ignore auto-query error */ }
              } catch (error) {
                showToast(error.message, true);
              }
              await refreshStatus();
            } finally {
              state.tree.busy = false;
            }
          });
          colList.appendChild(colRow);
        });
      }
      item.appendChild(colList);
    }

    container.appendChild(item);
  });
}

let treeSearchTimer = null;

function setupTreeSearch() {
  const input = $("treeSearchInput");
  const clearBtn = $("treeSearchClearBtn");
  if (!input || !clearBtn) return;

  input.addEventListener("input", () => {
    clearTimeout(treeSearchTimer);
    const value = input.value.trim();
    clearBtn.hidden = !value;
    state.tree.searchKeyword = value;

    if (!value) {
      state.tree.searchMatches = [];
      state.tree.searchTruncated = false;
      state.tree.searching = false;
      renderDbTree();
      return;
    }

    state.tree.searching = true;
    renderDbTree();
    treeSearchTimer = setTimeout(runTreeSearch, 250);
  });

  clearBtn.addEventListener("click", () => {
    clearTimeout(treeSearchTimer);
    input.value = "";
    clearBtn.hidden = true;
    state.tree.searchKeyword = "";
    state.tree.searchMatches = [];
    state.tree.searchTruncated = false;
    state.tree.searching = false;
    renderDbTree();
    input.focus();
  });
}

async function runTreeSearch() {
  const keyword = state.tree.searchKeyword;
  if (!keyword) return;
  const token = ++state.tree.searchToken;
  try {
    const data = await api(
      `${API_BASE}/api/search-collections?keyword=${encodeURIComponent(keyword)}`,
    );
    if (token !== state.tree.searchToken) return;
    state.tree.searchMatches = data.matches || [];
    state.tree.searchTruncated = !!data.truncated;
  } catch (error) {
    if (token !== state.tree.searchToken) return;
    state.tree.searchMatches = [];
    showToast(error.message, true);
  } finally {
    if (token === state.tree.searchToken) {
      state.tree.searching = false;
      renderDbTree();
    }
  }
}

function highlightMatch(text, keyword) {
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  const before = escapeHtml(text.slice(0, idx));
  const hit = escapeHtml(text.slice(idx, idx + keyword.length));
  const after = escapeHtml(text.slice(idx + keyword.length));
  return `${before}<mark>${hit}</mark>${after}`;
}

function renderTreeSearchResults(container) {
  if (state.tree.searching) {
    const loading = document.createElement("div");
    loading.className = "tree-empty";
    loading.textContent = "搜索中...";
    container.appendChild(loading);
    return;
  }

  const matches = state.tree.searchMatches;
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "无匹配集合";
    container.appendChild(empty);
    return;
  }

  matches.forEach(({ database, collection }) => {
    const row = document.createElement("div");
    row.className = "tree-search-result";

    const driverType = state.status?.driverType || "mongo";
    const chipLabel = driverType === "postgres" ? "PG" : driverType === "mysql" ? "MS" : "MG";
    const chip = document.createElement("span");
    chip.className = `driver-chip driver-chip-${driverType}`;
    chip.textContent = chipLabel;
    chip.title = driverType === "postgres" ? "PostgreSQL" : driverType === "mysql" ? "MySQL/MariaDB" : "MongoDB";

    const name = document.createElement("span");
    name.className = "tree-search-result-name";
    name.innerHTML = highlightMatch(collection, state.tree.searchKeyword);

    const db = document.createElement("span");
    db.className = "tree-search-result-db";
    db.textContent = database;

    row.appendChild(chip);
    row.appendChild(name);
    row.appendChild(db);
    row.addEventListener("click", () => {
      void jumpToCollection(database, collection);
    });
    container.appendChild(row);
  });

  if (state.tree.searchTruncated) {
    const tip = document.createElement("div");
    tip.className = "tree-search-truncated";
    tip.textContent = "结果过多，请细化关键词";
    container.appendChild(tip);
  }
}

async function jumpToCollection(dbName, colName) {
  if (state.tree.busy) return;
  state.tree.busy = true;
  try {
    if (typeof isMobile === "function" && isMobile()) applySidebarCollapsed(true);

    const currentDb = state.status?.dbName || "";
    if (dbName !== currentDb) {
      const data = await api(`${API_BASE}/api/database`, {
        method: "POST",
        body: JSON.stringify({ dbName }),
      });
      setStatus(data.status);
      state.tree.expandedDbs.add(dbName);
      state.tree.collectionsMap[dbName] = data.collections || [];
    }

    const data = await api(`${API_BASE}/api/collection`, {
      method: "POST",
      body: JSON.stringify({ collectionName: colName }),
    });
    setStatus(data.status);
    renderDbTree();

    try {
      const qData = await api(`${API_BASE}/api/query`, {
        method: "POST",
        body: JSON.stringify({ filter: "{}", limit: 20 }),
      });
      state.docs = qData.docs;
      renderResults();
    } catch { /* ignore auto-query error */ }

    await refreshStatus();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.tree.busy = false;
  }
}

function renderStatusChip(status) {
  const chip = $("statusChip");
  if (!chip) {
    return;
  }

  const draftContext = getDraftContext();

  if (state.connecting) {
    chip.textContent = draftContext.canDisconnectActive ? "断开中..." : "连接中...";
    chip.classList.remove("connected");
    chip.classList.add("connecting");
    return;
  }

  chip.classList.remove("connecting");
  if (!draftContext.canDisconnectActive && draftContext.draft.uri) {
    if (draftContext.isNewDraft) {
      chip.textContent = "新连接草稿 · 未连接";
    } else if (draftContext.boundConnection) {
      chip.textContent = `待连接: ${draftContext.boundConnection.name || "已有配置"}`;
    } else {
      chip.textContent = "未连接";
    }
  } else if (status.connected) {
    chip.textContent = `${status.connectionName || "当前连接"} · ${
      status.dbName || "(未选库)"
    } / ${status.collectionName || "(未选集合)"}`;
  } else if (status.activeConnectionId) {
    chip.textContent = `未连接 · ${status.connectionName || "已选配置"}`;
  } else {
    chip.textContent = "未连接";
  }
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

  const draftContext = getDraftContext();

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

  const isConnected = draftContext.canDisconnectActive;
  const icon = connectToggleIconPath(isConnected);
  button.disabled = false;
  button.classList.remove("is-connecting");
  button.classList.toggle("is-connected", isConnected);
  let nextLabel = "连接数据库";
  if (isConnected) {
    nextLabel = "断开当前连接";
  } else if (draftContext.isNewDraft) {
    nextLabel = "创建并连接新配置";
  } else if (draftContext.boundConnection && !draftContext.affectsActive) {
    nextLabel = "切换并连接此配置";
  } else if (draftContext.boundConnection) {
    nextLabel = "连接当前配置";
  }
  button.setAttribute("aria-label", nextLabel);
  button.title = nextLabel;
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

function getSavedQueryInputCollapsed() {
  try {
    return localStorage.getItem(QUERY_INPUT_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveQueryInputCollapsed(collapsed) {
  try {
    localStorage.setItem(QUERY_INPUT_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function applyQueryInputCollapsed(collapsed, { persist = true } = {}) {
  const isCollapsed = Boolean(collapsed);
  state.queryInputCollapsed = isCollapsed;

  const builderPanel = $("queryBuilderPanel");
  const terminalPanel = $("queryTerminalPanel");
  const builderCollapseBtn = $("builderCollapseBtn");
  const terminalCollapseBtn = $("terminalCollapseBtn");

  if (builderPanel) {
    builderPanel.classList.toggle("collapsed", isCollapsed);
  }
  if (terminalPanel) {
    terminalPanel.classList.toggle("collapsed", isCollapsed);
  }

  [builderCollapseBtn, terminalCollapseBtn].forEach((btn) => {
    if (!btn) return;
    btn.setAttribute("aria-label", isCollapsed ? "展开查询输入区" : "折叠查询输入区");
    btn.title = isCollapsed ? "展开查询输入区" : "折叠查询输入区";
    const path = btn.querySelector("path");
    if (path) {
      path.setAttribute("d", isCollapsed ? "M6 9l6 6 6-6" : "M18 15l-6-6-6 6");
    }
  });

  if (canvasTable) {
    setTimeout(() => canvasTable._resize(), 0);
  }

  if (persist) {
    saveQueryInputCollapsed(isCollapsed);
  }
}

function updateOperationTabbarVisibility() {
  const bar = document.querySelector(".operation-tabbar");
  if (!bar) {
    return;
  }
  const activeTab = document.querySelector(".tab.active")?.dataset.tab || "query";
  const shouldHide = activeTab === "query" && state.queryInputMode === "terminal";
  bar.hidden = false;
  bar.classList.toggle("is-hidden", shouldHide);
}

function mountQueryCornerControls(mode = state.queryInputMode) {
  const controls = $("queryCornerControls");
  if (!controls) {
    return;
  }

  const activeTab = document.querySelector(".tab.active")?.dataset.tab || "query";
  const shouldShow = activeTab === "query";
  controls.hidden = false;
  controls.classList.toggle("is-hidden", !shouldShow);
  if (!shouldShow) {
    return;
  }

  const host = mode === "terminal" ? $("terminalCornerHost") : $("builderCornerHost");
  if (!host) {
    return;
  }

  if (controls.parentElement !== host) {
    host.appendChild(controls);
  }
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

  closeAllQuerySelects();
  mountQueryCornerControls(nextMode);
  updateOperationTabbarVisibility();
  applyQueryInputCollapsed(state.queryInputCollapsed, { persist: false });

  if (persist) {
    saveQueryInputMode(nextMode);
  }
}

function terminalHostFromUri(uri) {
  if (!uri) {
    return "localhost:16016";
  }
  try {
    const parsed = new URL(uri);
    return parsed.host || "localhost:16016";
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
  const isSql = status.driverType === "postgres" || status.driverType === "mysql";
  if (!status.connected) {
    context.textContent = status.connectionName || "未连接";
    prompt.textContent = isSql ? "sql>" : "db.(collection)>";
    return;
  }

  const host = terminalHostFromUri(status.uri);
  const dbName = status.dbName || "(未选库)";
  const collectionName = status.collectionName || "(未选表)";
  context.textContent = `${host}  ·  ${dbName}  ·  ${collectionName}`;
  prompt.textContent = isSql
    ? `${status.driverType}>`
    : `${dbName}.${collectionName}>`;
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
    modeSwitcher.hidden = false;
    modeSwitcher.classList.toggle("is-hidden", target !== "query");
  }

  mountQueryCornerControls(state.queryInputMode);
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
  renderDbTree();
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
  const prefix = refs.button.dataset.prefix?.trim();
  const baseLabel = matched.textContent.trim();
  refs.button.querySelector(".theme-select-btn-label").textContent = prefix
    ? `${prefix} · ${baseLabel}`
    : baseLabel;
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
  const data = await api(`${API_BASE}/api/status`);
  setStatus(data.status);
}

async function refreshConnections({ preserveDraft = false, fallbackToActive = false } = {}) {
  const data = await api(`${API_BASE}/api/connections`);
  state.connections = data.connections || [];
  if (data.status) {
    setStatus(data.status);
  }

  if (preserveDraft) {
    if (state.editingConnectionId && !findSavedConnection(state.editingConnectionId)) {
      state.editingConnectionId = null;
    }
    renderConnectionList();
    return data;
  }

  let nextEditingId = state.editingConnectionId;
  if (nextEditingId && !findSavedConnection(nextEditingId)) {
    nextEditingId = null;
  }
  if (!nextEditingId && fallbackToActive) {
    nextEditingId = data.activeConnectionId || activeConnectionId();
  }

  state.editingConnectionId = nextEditingId || null;
  const editing = editingConnection();
  if (editing) {
    applyConnectionDraft(editing);
  } else if (!preserveDraft) {
    clearConnectionDraft();
  }

  renderConnectionList();
  return data;
}

async function refreshDatabases({ suppressError = false } = {}) {
  if (!state.status?.connected) {
    state.tree.databases = [];
    return { warning: null };
  }
  try {
    const data = await api(`${API_BASE}/api/databases`);
    state.tree.databases = data.databases.map((d) => d.name);
    if (state.status?.dbName) {
      state.tree.expandedDbs.add(state.status.dbName);
    }
    return { warning: data.warning || null };
  } catch (error) {
    state.tree.databases = [];
    if (!suppressError) {
      throw error;
    }
    return { warning: error.message };
  }
}

async function refreshCollections({ suppressError = false } = {}) {
  if (!state.status?.connected || !state.status?.dbName) {
    return { warning: null };
  }
  try {
    const data = await api(`${API_BASE}/api/collections`);
    const dbName = state.status.dbName;
    state.tree.collectionsMap[dbName] = data.collections;
    state.tree.expandedDbs.add(dbName);
    return { warning: data.warning || null };
  } catch (error) {
    if (!suppressError) {
      throw error;
    }
    return { warning: error.message };
  }
}

/* ── Canvas Table ── */

let canvasTable = null;

const CT_COLORS = {
  headerBg: "#f7ecdf",
  headerText: "#7a6b5a",
  cellBgEven: "#fffdf8",
  cellBgOdd: "#faf5ed",
  cellText: "#2c241b",
  border: "#eadbca",
  selection: "#5b7a9d",
  hover: "#f8f0e4",
  editBorder: "#5b7a9d",
  idBadgeBg: "#f8ecdd",
  idBadgeBorder: "#decdbb",
  idBadgeText: "#4f3d2d",
  danger: "#c0392b",
  rowSelected: "#fbeccb",
  rowSelectedStripe: "#f6e0b6",
  checkboxStroke: "#7a6b5a",
  checkboxFill: "#b6791f",
  checkboxIndeterminate: "#a98a4a",
  marqueeFill: "rgba(182, 121, 31, 0.14)",
  marqueeStroke: "#b6791f",
};

const CT_DEFAULTS = {
  headerHeight: 30,
  rowHeight: 28,
  fontSize: 12,
  idColWidth: 120,
  defaultColWidth: 160,
  actionColWidth: 52,
  selectColWidth: 34,
  minColWidth: 40,
  maxColWidth: 400,
};

function parseEditedValue(raw, original) {
  const text = String(raw).trim();
  if (!text) return null;
  if (typeof original === "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    if (typeof original === "number") {
      const n = Number(text);
      if (!Number.isNaN(n)) return n;
    }
    return text;
  }
}

class CanvasTable {
  constructor(container, options) {
    this.container = container;
    this.onDelete = options.onDelete || (() => {});
    this.onSelectionChange = options.onSelectionChange || (() => {});
    this.docs = options.docs || [];
    this.displayDocs = options.displayDocs || [];

    this.canvas = document.createElement("canvas");
    this.canvas.className = "ct-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.dpr = window.devicePixelRatio || 1;

    this.wrapper = document.createElement("div");
    this.wrapper.className = "ct-container";
    this.wrapper.appendChild(this.canvas);
    container.appendChild(this.wrapper);

    this.width = 600;
    this.height = 300;
    this.scrollX = 0;
    this.scrollY = 0;
    this.maxScrollX = 0;
    this.maxScrollY = 0;

    this.selectedCell = null;
    this.hoverCell = null;
    this.editingCell = null;
    this.previewEl = null;

    this.selectedRows = new Set();
    this.lastAnchorRow = null;
    this.selectionDrag = null; // { startRow, currentRow, mode: 'replace' | 'toggle' }
    this._headerCheckboxRect = null;

    this.resizingCol = null;
    this.resizeStartX = 0;
    this.resizeStartWidth = 0;

    this.lastTapTime = 0;
    this.lastTapCell = null;
    this.touchStartX = 0;
    this.touchStartY = 0;
    this.touchScrollX = 0;
    this.touchScrollY = 0;
    this.isTouchScrolling = false;

    this._rafId = null;
    this._dirty = false;
    this._destroyed = false;
    this._bound = {};
    this._newRow = null;       // pending new row doc object, null = no new row
    this._addBtnRect = null;   // "+" button hit area {x, y, w, h} in canvas coords

    this._computeCols();
    this._bindEvents();
    // Synchronous resize triggers reflow and sets canvas dimensions
    this._resize();
  }

  _computeCols() {
    const cols = [];
    const seen = new Set();
    this.docs.slice(0, 30).forEach((doc) => {
      Object.keys(doc).forEach((key) => {
        if (!seen.has(key)) {
          seen.add(key);
        }
      });
    });
    cols.push({ key: "__select__", label: "", width: window.innerWidth < 760 ? 44 : CT_DEFAULTS.selectColWidth });
    if (!seen.has("_id")) {
      cols.push({ key: "_id", label: "_id", width: CT_DEFAULTS.idColWidth });
    }
    seen.forEach((key) => {
      if (key === "_id") {
        cols.push({ key: "_id", label: "_id", width: CT_DEFAULTS.idColWidth });
      } else {
        cols.push({ key, label: key, width: CT_DEFAULTS.defaultColWidth });
      }
    });
    cols.push({ key: "__action__", label: "", width: CT_DEFAULTS.actionColWidth });
    this.cols = cols;
    this._updateScrollBounds();
  }

  _resize() {
    const parentRect = this.container.getBoundingClientRect();
    let w = Math.max(200, Math.floor(parentRect.width));
    // Use available viewport space from container top to bottom
    const availableH = Math.floor(window.innerHeight - parentRect.top - 12);
    let h = Math.max(200, Math.min(availableH, Math.floor(window.innerHeight * 0.7)));
    if (w < 200) w = 200;
    this.width = w;
    this.height = h;
    this.wrapper.style.width = `${w}px`;
    this.wrapper.style.height = `${h}px`;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this._updateScrollBounds();
    this.scheduleRender();
  }

  _updateScrollBounds() {
    const totalWidth = this.cols.reduce((s, c) => s + c.width, 0);
    const totalHeight = CT_DEFAULTS.headerHeight + this.docs.length * CT_DEFAULTS.rowHeight;
    this.maxScrollX = Math.max(0, totalWidth - this.width);
    this.maxScrollY = Math.max(0, totalHeight - this.height);
    this.scrollX = Math.min(this.scrollX, this.maxScrollX);
    this.scrollY = Math.min(this.scrollY, this.maxScrollY);
  }

  _isNewRow(row) {
    return this._newRow !== null && row >= 0 && row < this.docs.length && this.docs[row] === this._newRow;
  }

  _startNewRow() {
    if (this._newRow) return; // already adding
    const emptyDoc = { _id: null };
    this.docs.push(emptyDoc);
    this.displayDocs.push({ _id: "new" });
    this._newRow = emptyDoc;
    this._updateScrollBounds();
    // Scroll to bottom
    this.scrollY = this.maxScrollY;
    this.scheduleRender();
  }

  async _commitNewRow() {
    if (!this._newRow) return;
    if (this.editingCell) this._commitInlineEdit();
    const doc = { ...this._newRow };
    delete doc._id;
    const cleanDoc = {};
    for (const [k, v] of Object.entries(doc)) {
      if (v !== undefined && v !== null && v !== "") cleanDoc[k] = v;
    }
    if (Object.keys(cleanDoc).length === 0) {
      showToast("文档不能为空", true);
      return;
    }
    try {
      const data = await api(`${API_BASE}/api/insert`, {
        method: "POST",
        body: JSON.stringify({ doc: JSON.stringify(cleanDoc) }),
      });
      this._newRow._id = data.insertedId;
      const idx = this.docs.indexOf(this._newRow);
      if (idx >= 0) this.displayDocs[idx]._id = data.insertedId;
      this._newRow = null;
      showToast("插入成功");
      this.scheduleRender();
    } catch (error) {
      showToast(`插入失败: ${error.message}`, true);
    }
  }

  _cancelNewRow() {
    if (!this._newRow) return;
    if (this.editingCell) this.cancelEdit();
    const idx = this.docs.indexOf(this._newRow);
    if (idx >= 0) {
      this.docs.splice(idx, 1);
      this.displayDocs.splice(idx, 1);
    }
    this._newRow = null;
    this._updateScrollBounds();
    this.scheduleRender();
  }

  _bindEvents() {
    const b = this._bound;

    b.resize = () => this._resize();
    window.addEventListener("resize", b.resize);

    b.click = (e) => this._handleClick(e);
    b.dblclick = (e) => this._handleDblClick(e);
    b.mousemove = (e) => this._handleMouseMove(e);
    b.mousedown = (e) => this._handleMouseDown(e);
    b.mouseup = (e) => this._handleMouseUp(e);
    b.wheel = (e) => this._handleWheel(e);
    b.touchstart = (e) => this._handleTouchStart(e);
    b.touchmove = (e) => this._handleTouchMove(e);
    b.touchend = (e) => this._handleTouchEnd(e);
    b.keydown = (e) => this._handleKeyDown(e);

    this.canvas.addEventListener("click", b.click);
    this.canvas.addEventListener("dblclick", b.dblclick);
    this.canvas.addEventListener("mousemove", b.mousemove);
    this.canvas.addEventListener("mousedown", b.mousedown);
    this.canvas.addEventListener("wheel", b.wheel, { passive: false });
    this.canvas.addEventListener("touchstart", b.touchstart, { passive: false });
    this.canvas.addEventListener("touchmove", b.touchmove, { passive: false });
    this.canvas.addEventListener("touchend", b.touchend);
    document.addEventListener("mouseup", b.mouseup);
    document.addEventListener("keydown", b.keydown);
  }

  _getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _hitTest(mx, my) {
    if (mx < 0 || my < 0) return null;
    const colIdx = this._colAtX(mx + this.scrollX);
    if (colIdx < 0) return null;
    if (my < CT_DEFAULTS.headerHeight) {
      return { row: -1, col: colIdx };
    }
    const rowIdx = Math.floor((my - CT_DEFAULTS.headerHeight + this.scrollY) / CT_DEFAULTS.rowHeight);
    if (rowIdx < 0 || rowIdx >= this.docs.length) return null;
    return { row: rowIdx, col: colIdx };
  }

  _colAtX(x) {
    let cx = 0;
    for (let i = 0; i < this.cols.length; i++) {
      if (x >= cx && x < cx + this.cols[i].width) return i;
      cx += this.cols[i].width;
    }
    return -1;
  }

  _colBoundary(x) {
    let cx = 0;
    for (let i = 0; i < this.cols.length; i++) {
      cx += this.cols[i].width;
      if (Math.abs(x - cx) <= 4) return i;
    }
    return -1;
  }

  _cellRect(row, col) {
    let x = -this.scrollX;
    for (let i = 0; i < col; i++) x += this.cols[i].width;
    const y = CT_DEFAULTS.headerHeight + row * CT_DEFAULTS.rowHeight - this.scrollY;
    return { x, y, w: this.cols[col].width, h: CT_DEFAULTS.rowHeight };
  }

  _isActionCol(col) {
    return this.cols[col]?.key === "__action__";
  }

  _isIdCol(col) {
    return this.cols[col]?.key === "_id";
  }

  _isSelectCol(col) {
    return this.cols[col]?.key === "__select__";
  }

  scheduleRender() {
    if (!this._dirty) {
      this._dirty = true;
      this._rafId = requestAnimationFrame(() => {
        this._dirty = false;
        this.render();
      });
    }
  }

  render() {
    if (this._destroyed) return;
    try {
      const ctx = this.ctx;
      const dpr = this.dpr;
      const w = this.width;
      const h = this.height;
      if (w <= 0 || h <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Fill background
      ctx.fillStyle = CT_COLORS.cellBgEven;
      ctx.fillRect(0, 0, w, h);
      this._drawHeader();
      this._drawBody();
    } catch (err) {
      console.error("[CanvasTable] render error:", err);
    }
  }

  _drawHeader() {
    const ctx = this.ctx;
    const hh = CT_DEFAULTS.headerHeight;
    ctx.save();
    ctx.fillStyle = CT_COLORS.headerBg;
    ctx.fillRect(0, 0, this.width, hh);
    ctx.fillStyle = CT_COLORS.headerText;
    ctx.font = `500 ${CT_DEFAULTS.fontSize}px -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";

    let x = -this.scrollX;
    for (let i = 0; i < this.cols.length; i++) {
      const col = this.cols[i];
      if (x + col.width > 0 && x < this.width) {
        if (col.key === "__action__") {
          // Draw "+" add button
          this._drawAddBtn(x, 0, col.width, hh);
        } else if (col.key === "__select__") {
          this._drawHeaderCheckbox(x, 0, col.width, hh);
        } else {
          ctx.save();
          ctx.beginPath();
          ctx.rect(Math.max(0, x), 0, col.width, hh);
          ctx.clip();
          ctx.fillText(col.label, x + 8, hh / 2);
          ctx.restore();
        }
      }
      x += col.width;
    }

    ctx.strokeStyle = CT_COLORS.border;
    ctx.beginPath();
    ctx.moveTo(0, hh);
    ctx.lineTo(this.width, hh);
    ctx.stroke();
    ctx.restore();
  }

  _drawBody() {
    const ctx = this.ctx;
    const hh = CT_DEFAULTS.headerHeight;
    const rh = CT_DEFAULTS.rowHeight;
    const fs = CT_DEFAULTS.fontSize;
    const startRow = Math.max(0, Math.floor(this.scrollY / rh));
    const visibleRows = Math.ceil((this.height - hh) / rh) + 1;
    const endRow = Math.min(this.docs.length, startRow + visibleRows);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, hh, this.width, this.height - hh);
    ctx.clip();

    const dragRange = this._getDragRange();

    for (let r = startRow; r < endRow; r++) {
      const ry = hh + r * rh - this.scrollY;
      const isOdd = r % 2 === 1;
      const isSelected = this.selectedRows.has(r);
      const inDragRange =
        dragRange && r >= dragRange.start && r <= dragRange.end;

      // Row background
      if (this._isNewRow(r)) {
        ctx.fillStyle = "#effaf3";
      } else if (isSelected || inDragRange) {
        ctx.fillStyle = isOdd
          ? CT_COLORS.rowSelectedStripe
          : CT_COLORS.rowSelected;
      } else {
        ctx.fillStyle = isOdd ? CT_COLORS.cellBgOdd : CT_COLORS.cellBgEven;
      }
      ctx.fillRect(0, ry, this.width, rh);

      // Hover highlight
      if (
        this.hoverCell &&
        this.hoverCell.row === r &&
        !this._isActionCol(this.hoverCell.col) &&
        !this._isSelectCol(this.hoverCell.col) &&
        !isSelected &&
        !inDragRange
      ) {
        ctx.fillStyle = CT_COLORS.hover;
        let hx = -this.scrollX;
        for (let i = 0; i < this.hoverCell.col; i++) hx += this.cols[i].width;
        ctx.fillRect(hx, ry, this.cols[this.hoverCell.col].width, rh);
      }

      // Selection highlight (single cell focus)
      if (this.selectedCell && this.selectedCell.row === r) {
        const sc = this.selectedCell.col;
        let sx = -this.scrollX;
        for (let i = 0; i < sc; i++) sx += this.cols[i].width;
        ctx.strokeStyle = CT_COLORS.selection;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx + 0.75, ry + 0.75, this.cols[sc].width - 1.5, rh - 1.5);
        ctx.lineWidth = 1;
      }

      // Cells
      let cx = -this.scrollX;
      for (let c = 0; c < this.cols.length; c++) {
        const col = this.cols[c];
        if (cx + col.width > 0 && cx < this.width) {
          this._drawCell(r, c, cx, ry, col.width, rh);
        }
        cx += col.width;
      }
    }

    // Grid lines
    ctx.strokeStyle = CT_COLORS.border;
    ctx.lineWidth = 0.5;
    let lx = -this.scrollX;
    for (let i = 0; i < this.cols.length; i++) {
      lx += this.cols[i].width;
      if (lx > 0 && lx < this.width) {
        ctx.beginPath();
        ctx.moveTo(lx, hh);
        ctx.lineTo(lx, this.height);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  _drawCell(row, col, x, y, w, h) {
    const ctx = this.ctx;
    const key = this.cols[col].key;
    const monoFont = `${CT_DEFAULTS.fontSize}px "SF Mono", Menlo, "IBM Plex Mono", monospace`;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, y, w - 2, h);
    ctx.clip();

    if (this._isActionCol(col)) {
      if (this._isNewRow(row)) {
        // Draw ✓ / ✗ split
        const halfW = w / 2;
        this._drawConfirmIcon(x + halfW / 2, y + h / 2);
        this._drawCancelIcon(x + halfW + halfW / 2, y + h / 2);
      } else {
        this._drawDeleteIcon(x + w / 2, y + h / 2);
      }
      ctx.restore();
      return;
    }

    if (this._isSelectCol(col)) {
      if (!this._isNewRow(row)) {
        const checked = this.selectedRows.has(row);
        const dragRange = this._getDragRange();
        const inDrag =
          dragRange && row >= dragRange.start && row <= dragRange.end;
        this._drawCheckbox(x + w / 2, y + h / 2, checked || (inDrag && this.selectionDrag?.mode === "add"));
      }
      ctx.restore();
      return;
    }

    // New row _id column: show "new" badge
    if (this._isNewRow(row) && this._isIdCol(col)) {
      ctx.font = `${CT_DEFAULTS.fontSize - 1}px "SF Mono", Menlo, "IBM Plex Mono", monospace`;
      ctx.textBaseline = "middle";
      const label = "new";
      const bx = x + 4;
      const by = y + (h - 18) / 2;
      const badgeW = ctx.measureText(label).width + 12;
      const badgeRW = Math.min(badgeW, w - 8);
      const badgeRH = 18;
      const badgeR = 3;

      ctx.fillStyle = "#ddf5ee";
      ctx.strokeStyle = "#a3dfc4";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + badgeR, by);
      ctx.lineTo(bx + badgeRW - badgeR, by);
      ctx.quadraticCurveTo(bx + badgeRW, by, bx + badgeRW, by + badgeR);
      ctx.lineTo(bx + badgeRW, by + badgeRH - badgeR);
      ctx.quadraticCurveTo(bx + badgeRW, by + badgeRH, bx + badgeRW - badgeR, by + badgeRH);
      ctx.lineTo(bx + badgeR, by + badgeRH);
      ctx.quadraticCurveTo(bx, by + badgeRH, bx, by + badgeRH - badgeR);
      ctx.lineTo(bx, by + badgeR);
      ctx.quadraticCurveTo(bx, by, bx + badgeR, by);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#0e8c6a";
      ctx.fillText(label, bx + 6, by + 9);
      ctx.restore();
      return;
    }

    if (this._isIdCol(col)) {
      const idVal = this.docs[row]?._id;
      const shortId = readIdValue(idVal).slice(-5);
      ctx.font = `${CT_DEFAULTS.fontSize - 1}px "SF Mono", Menlo, "IBM Plex Mono", monospace`;
      ctx.textBaseline = "middle";
      const badgeW = ctx.measureText(shortId).width + 12;
      const bx = x + 4;
      const by = y + (h - 18) / 2;

      ctx.fillStyle = CT_COLORS.idBadgeBg;
      ctx.strokeStyle = CT_COLORS.idBadgeBorder;
      ctx.lineWidth = 1;
      const badgeRW = Math.min(badgeW, w - 8);
      const badgeRH = 18;
      const badgeR = 3;
      ctx.beginPath();
      ctx.moveTo(bx + badgeR, by);
      ctx.lineTo(bx + badgeRW - badgeR, by);
      ctx.quadraticCurveTo(bx + badgeRW, by, bx + badgeRW, by + badgeR);
      ctx.lineTo(bx + badgeRW, by + badgeRH - badgeR);
      ctx.quadraticCurveTo(bx + badgeRW, by + badgeRH, bx + badgeRW - badgeR, by + badgeRH);
      ctx.lineTo(bx + badgeR, by + badgeRH);
      ctx.quadraticCurveTo(bx, by + badgeRH, bx, by + badgeRH - badgeR);
      ctx.lineTo(bx, by + badgeR);
      ctx.quadraticCurveTo(bx, by, bx + badgeR, by);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = CT_COLORS.idBadgeText;
      ctx.fillText(shortId, bx + 6, by + 9);
      ctx.restore();
      return;
    }

    const displayVal = this.displayDocs[row]?.[key];
    const text = stringifyValue(displayVal);

    ctx.fillStyle = CT_COLORS.cellText;
    ctx.font = monoFont;
    ctx.textBaseline = "middle";

    const padding = 6;
    const maxW = w - padding * 2;
    let displayText = text;
    if (maxW > 20 && text.length > 0 && ctx.measureText(text).width > maxW) {
      while (displayText.length > 1 && ctx.measureText(displayText + "…").width > maxW) {
        displayText = displayText.slice(0, -1);
      }
      displayText += "…";
    }
    ctx.fillText(displayText, x + padding, y + h / 2);
    ctx.restore();
  }

  _drawCheckbox(cx, cy, state) {
    const ctx = this.ctx;
    const size = 13;
    const x = cx - size / 2;
    const y = cy - size / 2;
    const r = 3;
    ctx.save();
    ctx.lineWidth = 1.2;
    if (state === "indeterminate") {
      ctx.fillStyle = CT_COLORS.checkboxIndeterminate;
      ctx.strokeStyle = CT_COLORS.checkboxIndeterminate;
    } else if (state) {
      ctx.fillStyle = CT_COLORS.checkboxFill;
      ctx.strokeStyle = CT_COLORS.checkboxFill;
    } else {
      ctx.fillStyle = "#fffdf8";
      ctx.strokeStyle = CT_COLORS.checkboxStroke;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + size - r, y);
    ctx.quadraticCurveTo(x + size, y, x + size, y + r);
    ctx.lineTo(x + size, y + size - r);
    ctx.quadraticCurveTo(x + size, y + size, x + size - r, y + size);
    ctx.lineTo(x + r, y + size);
    ctx.quadraticCurveTo(x, y + size, x, y + size - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (state === "indeterminate") {
      ctx.strokeStyle = "#fffdf8";
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x + 3.5, cy);
      ctx.lineTo(x + size - 3.5, cy);
      ctx.stroke();
    } else if (state) {
      ctx.strokeStyle = "#fffdf8";
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x + 3, cy + 0.5);
      ctx.lineTo(x + size / 2 - 0.5, cy + 3.5);
      ctx.lineTo(x + size - 3, cy - 2.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawHeaderCheckbox(x, y, w, h) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const total = this.docs.length;
    const sel = this.selectedRows.size;
    let state = false;
    if (sel > 0 && sel < total) state = "indeterminate";
    else if (sel > 0 && sel >= total) state = true;
    // hit area covers whole header cell so click is forgiving
    this._headerCheckboxRect = { x, y, w, h };
    this._drawCheckbox(cx, cy, state);
  }

  _getDragRange() {
    if (!this.selectionDrag) return null;
    const { startRow, currentRow } = this.selectionDrag;
    return {
      start: Math.min(startRow, currentRow),
      end: Math.max(startRow, currentRow),
    };
  }

  _notifySelectionChange() {
    this.onSelectionChange(this.selectedRows.size);
  }

  selectAll() {
    this.selectedRows.clear();
    for (let i = 0; i < this.docs.length; i++) {
      if (!this._isNewRow(i)) this.selectedRows.add(i);
    }
    this.lastAnchorRow = null;
    this.scheduleRender();
    this._notifySelectionChange();
  }

  clearSelection() {
    this.selectedRows.clear();
    this.lastAnchorRow = null;
    this.scheduleRender();
    this._notifySelectionChange();
  }

  getSelectedDocs() {
    const out = [];
    if (this.selectedRows.size === 0) return out;
    const rows = [...this.selectedRows].sort((a, b) => a - b);
    for (const r of rows) {
      const doc = this.docs[r];
      if (doc) out.push(doc);
    }
    return out;
  }

  _handleRowSelectClick(row, { shift, ctrl }) {
    if (this._isNewRow(row)) return;
    if (shift && this.lastAnchorRow !== null) {
      const start = Math.min(this.lastAnchorRow, row);
      const end = Math.max(this.lastAnchorRow, row);
      for (let i = start; i <= end; i++) {
        if (!this._isNewRow(i)) this.selectedRows.add(i);
      }
    } else {
      // 普通点击 / ctrl+click 都按 toggle 处理（复选框语义）
      if (this.selectedRows.has(row)) this.selectedRows.delete(row);
      else this.selectedRows.add(row);
      this.lastAnchorRow = row;
    }
    this.scheduleRender();
    this._notifySelectionChange();
  }

  _isMacCtrl() {
    return false;
  }

  _drawDeleteIcon(cx, cy) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = CT_COLORS.danger;
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const s = 5;
    // Trash can body
    ctx.beginPath();
    ctx.moveTo(cx - s, cy - s + 3);
    ctx.lineTo(cx - s + 1, cy + s);
    ctx.lineTo(cx + s - 1, cy + s);
    ctx.lineTo(cx + s, cy - s + 3);
    ctx.stroke();
    // Trash can lid
    ctx.beginPath();
    ctx.moveTo(cx - s - 1, cy - s + 3);
    ctx.lineTo(cx + s + 1, cy - s + 3);
    ctx.stroke();
    // Trash can handle
    ctx.beginPath();
    ctx.moveTo(cx - 2, cy - s + 3);
    ctx.lineTo(cx - 2, cy - s + 1);
    ctx.lineTo(cx + 2, cy - s + 1);
    ctx.lineTo(cx + 2, cy - s + 3);
    ctx.stroke();
    // Vertical lines inside
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - 2, cy - s + 6);
    ctx.lineTo(cx - 2, cy + s - 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - s + 6);
    ctx.lineTo(cx, cy + s - 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 2, cy - s + 6);
    ctx.lineTo(cx + 2, cy + s - 2);
    ctx.stroke();
    ctx.restore();
  }

  _drawAddBtn(x, y, w, h) {
    const ctx = this.ctx;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = 9;
    // Record hit area (canvas coords, not scrolled since header is fixed)
    this._addBtnRect = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
    ctx.save();
    // Green circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#e6f5ef";
    ctx.strokeStyle = "#0e8c6a";
    ctx.lineWidth = 1.2;
    ctx.fill();
    ctx.stroke();
    // "+" cross
    ctx.strokeStyle = "#0e8c6a";
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.stroke();
    ctx.restore();
  }

  _drawConfirmIcon(cx, cy) {
    const ctx = this.ctx;
    const r = 9;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#e6f5ef";
    ctx.strokeStyle = "#0e8c6a";
    ctx.lineWidth = 1.2;
    ctx.fill();
    ctx.stroke();
    // Check mark
    ctx.strokeStyle = "#0e8c6a";
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx - 1, cy + 3);
    ctx.lineTo(cx + 5, cy - 3);
    ctx.stroke();
    ctx.restore();
  }

  _drawCancelIcon(cx, cy) {
    const ctx = this.ctx;
    const r = 9;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#f5ece6";
    ctx.strokeStyle = "#9a8574";
    ctx.lineWidth = 1.2;
    ctx.fill();
    ctx.stroke();
    // X mark
    ctx.strokeStyle = "#9a8574";
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - 3.5, cy - 3.5);
    ctx.lineTo(cx + 3.5, cy + 3.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 3.5, cy - 3.5);
    ctx.lineTo(cx - 3.5, cy + 3.5);
    ctx.stroke();
    ctx.restore();
  }

  _handleClick(e) {
    if (this._skipNextClick) {
      this._skipNextClick = false;
      return;
    }
    const pos = this._getMousePos(e);
    const cell = this._hitTest(pos.x, pos.y);
    if (!cell) {
      this._closePreview();
      return;
    }

    // Header click
    if (cell.row < 0) {
      if (this._isSelectCol(cell.col)) {
        if (this.selectedRows.size > 0) this.clearSelection();
        else this.selectAll();
        return;
      }
      if (this._addBtnRect) {
        const r = this._addBtnRect;
        if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) {
          this._startNewRow();
        }
      }
      return;
    }

    // Select column click: multi-select with modifiers
    if (this._isSelectCol(cell.col)) {
      if (this._isNewRow(cell.row)) return;
      this._handleRowSelectClick(cell.row, {
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey,
      });
      return;
    }

    // Close any active editor first
    if (this.editingCell) {
      if (this._isNewRow(this.editingCell.row)) {
        this._commitInlineEdit();
      } else {
        this.cancelEdit();
      }
    }

    // New row action column: ✓ / ✗
    if (this._isActionCol(cell.col) && this._isNewRow(cell.row)) {
      const colX = this._cellRect(cell.row, cell.col).x;
      const halfW = this.cols[cell.col].width / 2;
      if (pos.x < colX + halfW) {
        void this._commitNewRow();
      } else {
        this._cancelNewRow();
      }
      return;
    }

    if (this._isActionCol(cell.col)) {
      const doc = this.docs[cell.row];
      if (doc) this.onDelete(doc);
      return;
    }

    // New row cells: click to edit directly
    if (this._isNewRow(cell.row)) {
      this.selectedCell = cell;
      this.scheduleRender();
      this._startEdit(cell.row, cell.col);
      return;
    }

    this.selectedCell = cell;
    this.scheduleRender();

    if (!this._isIdCol(cell.col)) {
      this._showPreview(cell.row, cell.col);
    }
  }

  _handleDblClick(e) {
    const pos = this._getMousePos(e);
    const cell = this._hitTest(pos.x, pos.y);
    if (!cell || cell.row < 0) return;
    if (this._isActionCol(cell.col)) return;
    if (this._isSelectCol(cell.col)) return;
    // New row: all columns editable (including _id)
    if (!this._isNewRow(cell.row) && this._isIdCol(cell.col)) return;
    this._closePreview();
    this._startEdit(cell.row, cell.col);
  }

  _handleMouseMove(e) {
    const pos = this._getMousePos(e);
    const cell = this._hitTest(pos.x, pos.y);

    // Drag-select in progress: update currentRow based on pointer Y
    if (this.selectionDrag) {
      const dx = e.clientX - this.selectionDrag.startX;
      const dy = e.clientY - this.selectionDrag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        this.selectionDrag.moved = true;
      }
      // Auto-scroll near top/bottom edges
      const hh = CT_DEFAULTS.headerHeight;
      if (pos.y > hh) {
        const edgeZone = 24;
        if (pos.y < hh + edgeZone) {
          this.scrollY = Math.max(0, this.scrollY - 6);
        } else if (pos.y > this.height - edgeZone) {
          this.scrollY = Math.min(this.maxScrollY, this.scrollY + 6);
        }
      }
      // Determine current row from Y (independent of X, so user can drag anywhere)
      if (pos.y > hh) {
        const rowIdx = Math.floor((pos.y - hh + this.scrollY) / CT_DEFAULTS.rowHeight);
        const clamped = Math.max(0, Math.min(this.docs.length - 1, rowIdx));
        if (this.selectionDrag.currentRow !== clamped) {
          this.selectionDrag.currentRow = clamped;
          this.scheduleRender();
        }
      }
      return;
    }

    if (this.resizingCol !== null) {
      const dx = e.clientX - this.resizeStartX;
      const newWidth = Math.max(CT_DEFAULTS.minColWidth, Math.min(CT_DEFAULTS.maxColWidth, this.resizeStartWidth + dx));
      this.cols[this.resizingCol].width = newWidth;
      this._updateScrollBounds();
      this.scheduleRender();
      return;
    }

    if (pos.y < CT_DEFAULTS.headerHeight) {
      // Check "+" button hit area
      if (this._addBtnRect) {
        const r = this._addBtnRect;
        if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) {
          this.canvas.style.cursor = "pointer";
          return;
        }
      }
      const boundary = this._colBoundary(pos.x + this.scrollX);
      this.canvas.style.cursor = boundary >= 0 ? "col-resize" : "default";
    } else if (cell && this._isSelectCol(cell.col)) {
      this.canvas.style.cursor = "pointer";
    } else if (cell && this._isActionCol(cell.col)) {
      this.canvas.style.cursor = "pointer";
    } else if (cell && this._isNewRow(cell.row)) {
      this.canvas.style.cursor = "text";
    } else if (cell && !this._isIdCol(cell.col)) {
      this.canvas.style.cursor = "text";
    } else {
      this.canvas.style.cursor = "default";
    }

    const prevHover = this.hoverCell;
    this.hoverCell = cell && cell.row >= 0 ? cell : null;
    if (!prevHover && !this.hoverCell) return;
    if (prevHover && this.hoverCell && prevHover.row === this.hoverCell.row && prevHover.col === this.hoverCell.col) return;
    this.scheduleRender();
  }

  _handleMouseDown(e) {
    const pos = this._getMousePos(e);
    if (pos.y < CT_DEFAULTS.headerHeight) {
      const boundary = this._colBoundary(pos.x + this.scrollX);
      if (boundary >= 0) {
        this.resizingCol = boundary;
        this.resizeStartX = e.clientX;
        this.resizeStartWidth = this.cols[boundary].width;
        e.preventDefault();
      }
      return;
    }
    // Start row drag-select from the checkbox column
    const cell = this._hitTest(pos.x, pos.y);
    if (cell && cell.row >= 0 && this._isSelectCol(cell.col) && !this._isNewRow(cell.row)) {
      const wasSelected = this.selectedRows.has(cell.row);
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      this.selectionDrag = {
        startRow: cell.row,
        currentRow: cell.row,
        mode: wasSelected && !additive ? "remove" : "add",
        baseSelection: new Set(this.selectedRows),
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
      };
      e.preventDefault();
    }
  }

  _handleMouseUp(e) {
    if (this.resizingCol !== null) {
      this.resizingCol = null;
    }
    if (this.selectionDrag) {
      const drag = this.selectionDrag;
      this.selectionDrag = null;
      if (drag.moved) {
        // Commit range selection (drag beyond a single row)
        const range = this._getDragRangeFrom(drag);
        if (range) {
          if (drag.mode === "remove") {
            for (let i = range.start; i <= range.end; i++) {
              this.selectedRows.delete(i);
            }
          } else {
            // additive: keep base, add range
            this.selectedRows = new Set(drag.baseSelection);
            for (let i = range.start; i <= range.end; i++) {
              if (!this._isNewRow(i)) this.selectedRows.add(i);
            }
          }
          this.lastAnchorRow = range.end;
          this.scheduleRender();
          this._notifySelectionChange();
        }
        this._skipNextClick = true;
      }
    }
  }

  _getDragRangeFrom(drag) {
    if (!drag) return null;
    return {
      start: Math.min(drag.startRow, drag.currentRow),
      end: Math.max(drag.startRow, drag.currentRow),
    };
  }

  _handleWheel(e) {
    e.preventDefault();
    const dx = e.deltaX || 0;
    const dy = e.deltaY || 0;
    // Horizontal: trackpad deltaX or Shift+wheel
    if (dx !== 0) {
      this.scrollX = Math.max(0, Math.min(this.maxScrollX, this.scrollX + dx));
    }
    if (e.shiftKey && dy !== 0) {
      this.scrollX = Math.max(0, Math.min(this.maxScrollX, this.scrollX + dy));
    } else if (dy !== 0) {
      this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.scrollY + dy));
    }
    this._closePreview();
    this.scheduleRender();
  }

  _handleTouchStart(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    this.touchStartX = t.clientX;
    this.touchStartY = t.clientY;
    this.touchScrollX = this.scrollX;
    this.touchScrollY = this.scrollY;
    this.isTouchScrolling = false;
  }

  _handleTouchMove(e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const dx = this.touchStartX - t.clientX;
    const dy = this.touchStartY - t.clientY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) this.isTouchScrolling = true;
    this.scrollX = Math.max(0, Math.min(this.maxScrollX, this.touchScrollX + dx));
    this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.touchScrollY + dy));
    this._closePreview();
    this.scheduleRender();
  }

  _handleTouchEnd(e) {
    if (this.isTouchScrolling) return;
    const rect = this.canvas.getBoundingClientRect();
    const t = e.changedTouches[0];
    const pos = { x: t.clientX - rect.left, y: t.clientY - rect.top };
    const cell = this._hitTest(pos.x, pos.y);
    if (!cell) return;

    // 标记已处理，避免浏览器合成的 click 事件再次触发 toggle / 编辑
    this._skipNextClick = true;

    // Tap on header checkbox column: toggle select-all
    if (cell.row < 0 && this._isSelectCol(cell.col)) {
      if (this.selectedRows.size > 0) this.clearSelection();
      else this.selectAll();
      return;
    }
    if (cell.row < 0) return;

    if (this._isSelectCol(cell.col)) {
      if (this._isNewRow(cell.row)) return;
      this._handleRowSelectClick(cell.row, { shift: false, ctrl: false });
      return;
    }

    if (this.editingCell) this._commitInlineEdit();

    // New row action column: ✓ / ✗
    if (this._isActionCol(cell.col) && this._isNewRow(cell.row)) {
      const colX = this._cellRect(cell.row, cell.col).x;
      const halfW = this.cols[cell.col].width / 2;
      if (pos.x < colX + halfW) {
        void this._commitNewRow();
      } else {
        this._cancelNewRow();
      }
      return;
    }

    // Single tap on mobile: select + edit directly
    if (this._isActionCol(cell.col)) {
      const doc = this.docs[cell.row];
      if (doc) this.onDelete(doc);
      return;
    }

    this.selectedCell = cell;
    this.scheduleRender();

    // New row or mobile: all columns editable
    if (this._isNewRow(cell.row) || !this._isIdCol(cell.col)) {
      this._startEdit(cell.row, cell.col);
    }
  }

  _handleKeyDown(e) {
    if (e.key === "Escape") {
      if (this.editingCell) {
        this.cancelEdit();
      } else if (this.previewEl) {
        this._closePreview();
      } else if (this.selectedRows.size > 0) {
        this.clearSelection();
      }
    }
  }

  _isComplexValue(value) {
    return value !== null && value !== undefined && typeof value === "object";
  }

  _valueToEditString(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }

  _startEdit(row, col) {
    if (this.editingCell) this.cancelEdit();
    this._closePreview();

    const key = this.cols[col].key;
    const doc = this.docs[row];
    if (!doc) return;
    const rawValue = doc[key];
    const isComplex = this._isComplexValue(rawValue);
    const isNew = this._isNewRow(row);
    const rect = this._cellRect(row, col);
    const canvasRect = this.canvas.getBoundingClientRect();

    // Calculate editor position, clamped within viewport
    let editorLeft = canvasRect.left + rect.x;
    let editorTop = canvasRect.top + rect.y;
    let editorWidth = rect.w;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    // Clamp left so editor doesn't overflow right edge
    if (editorLeft + editorWidth > viewportW - 8) {
      editorLeft = Math.max(8, viewportW - editorWidth - 8);
    }
    // Estimate editor height: input + bar (save/cancel) for normal rows
    const barH = isNew ? 0 : 30;
    const estimatedH = (isComplex ? CT_DEFAULTS.rowHeight * 4 : CT_DEFAULTS.rowHeight) + barH;
    if (editorTop + estimatedH > viewportH - 8) {
      editorTop = Math.max(8, viewportH - estimatedH - 8);
    }

    const el = document.createElement("div");
    el.className = isNew ? "ct-editor ct-editor-inline" : "ct-editor";
    el.style.left = `${editorLeft}px`;
    el.style.top = `${editorTop}px`;
    el.style.width = `${editorWidth}px`;

    const input = document.createElement(isComplex ? "textarea" : "input");
    input.className = "ct-editor-input";
    input.value = this._valueToEditString(rawValue);
    if (isComplex) {
      input.rows = 4;
      el.style.minHeight = `${CT_DEFAULTS.rowHeight * 4}px`;
    }

    if (isNew) {
      // Inline mode for new row: no save/cancel bar, just the input
      el.appendChild(input);
      document.body.appendChild(el);
      input.focus();
      if (!isComplex) input.select();

      this.editingCell = { row, col, inputEl: input, wrapperEl: el };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          this._commitInlineEdit();
          this._cancelNewRow();
        } else if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          this._commitInlineEdit();
          // Move to next editable cell
          const nextCol = this._findNextEditableCol(row, col, e.shiftKey ? -1 : 1);
          if (nextCol >= 0) {
            this._startEdit(row, nextCol);
          }
        }
      });

      input.addEventListener("blur", (e) => {
        // Only commit if focus is leaving to a non-editor element
        if (!el.contains(e.relatedTarget)) {
          this._commitInlineEdit();
        }
      });
    } else {
      // Normal mode: save/cancel button bar
      const bar = document.createElement("div");
      bar.className = "ct-editor-bar";

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "ct-editor-save";
      saveBtn.textContent = "保存";
      saveBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.commitEdit();
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "ct-editor-cancel";
      cancelBtn.textContent = "取消";
      cancelBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.cancelEdit();
      });

      bar.appendChild(saveBtn);
      bar.appendChild(cancelBtn);
      el.appendChild(input);
      el.appendChild(bar);
      document.body.appendChild(el);
      input.focus();
      if (!isComplex) input.select();

      this.editingCell = { row, col, inputEl: input, wrapperEl: el };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          this.cancelEdit();
        }
      });
    }
  }

  _commitInlineEdit() {
    if (!this.editingCell) return;
    const { row, col, inputEl, wrapperEl } = this.editingCell;
    const key = this.cols[col].key;
    const doc = this.docs[row];
    const originalValue = doc[key];
    const editValue = inputEl.value;

    const newValue = parseEditedValue(editValue, originalValue);
    this.editingCell = null;
    if (wrapperEl && wrapperEl.isConnected) wrapperEl.remove();

    if (JSON.stringify(originalValue) === JSON.stringify(newValue)) return;

    // Update local data only
    doc[key] = newValue;
    this.displayDocs[row][key] = toDisplayValue(newValue);
    this.scheduleRender();
  }

  _findNextEditableCol(row, currentCol, direction) {
    let next = currentCol + direction;
    while (next >= 0 && next < this.cols.length) {
      if (!this._isActionCol(next) && !this._isIdCol(next) && !this._isSelectCol(next)) {
        return next;
      }
      next += direction;
    }
    return -1;
  }

  async commitEdit() {
    if (!this.editingCell) return;
    const { row, col, inputEl, wrapperEl } = this.editingCell;
    const key = this.cols[col].key;
    const doc = this.docs[row];
    const originalValue = doc[key];
    const editValue = inputEl.value;

    const newValue = parseEditedValue(editValue, originalValue);
    this.editingCell = null;
    if (wrapperEl && wrapperEl.isConnected) wrapperEl.remove();

    if (JSON.stringify(originalValue) === JSON.stringify(newValue)) return;

    try {
      const filterStr = formatJson({ _id: doc._id });
      await api(`${API_BASE}/api/update`, {
        method: "POST",
        body: JSON.stringify({ filter: filterStr, update: JSON.stringify({ [key]: newValue }), many: false }),
      });
      doc[key] = newValue;
      this.displayDocs[row][key] = toDisplayValue(newValue);
      showToast(`已更新字段 ${key}`);
      this.scheduleRender();
    } catch (error) {
      showToast(`更新失败: ${error.message}`, true);
      this.scheduleRender();
    }
  }

  cancelEdit() {
    if (!this.editingCell) return;
    const { wrapperEl } = this.editingCell;
    this.editingCell = null;
    if (wrapperEl && wrapperEl.isConnected) wrapperEl.remove();
    this.scheduleRender();
  }

  _showPreview(row, col) {
    this._closePreview();
    const key = this.cols[col].key;
    const displayVal = this.displayDocs[row]?.[key];
    const text = stringifyValue(displayVal);

    const ctx = this.ctx;
    ctx.font = `${CT_DEFAULTS.fontSize}px "SF Mono", Menlo, monospace`;
    const colW = this.cols[col].width - 12;
    if (ctx.measureText(text).width <= colW) return;

    const el = document.createElement("div");
    el.className = "ct-preview";

    const pre = document.createElement("pre");
    pre.textContent = text;
    el.appendChild(pre);

    const actions = document.createElement("div");
    actions.className = "ct-preview-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "ct-preview-edit-btn";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", () => {
      this._closePreview();
      this._startEdit(row, col);
    });
    actions.appendChild(editBtn);
    el.appendChild(actions);

    document.body.appendChild(el);

    const rect = this._cellRect(row, col);
    const canvasRect = this.canvas.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    let top = canvasRect.top + rect.y + rect.h + 4;
    let left = canvasRect.left + rect.x;
    if (left + elRect.width > window.innerWidth - 8) left = window.innerWidth - elRect.width - 8;
    if (top + elRect.height > window.innerHeight - 8) top = canvasRect.top + rect.y - elRect.height - 4;
    if (left < 8) left = 8;
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;

    this.previewEl = el;

    const closeOnOutside = (e) => {
      if (!el.contains(e.target) && e.target !== this.canvas) {
        this._closePreview();
        document.removeEventListener("mousedown", closeOnOutside);
        document.removeEventListener("touchstart", closeOnOutside);
      }
    };
    setTimeout(() => {
      document.addEventListener("mousedown", closeOnOutside);
      document.addEventListener("touchstart", closeOnOutside);
    }, 50);
  }

  _closePreview() {
    if (this.previewEl) {
      this.previewEl.remove();
      this.previewEl = null;
    }
  }

  removeRow(doc) {
    const idx = this.docs.indexOf(doc);
    if (idx < 0) return;
    this.docs.splice(idx, 1);
    this.displayDocs.splice(idx, 1);
    // Reindex selection: remove idx, shift any row > idx down by 1
    if (this.selectedRows.size > 0) {
      const next = new Set();
      for (const r of this.selectedRows) {
        if (r === idx) continue;
        next.add(r > idx ? r - 1 : r);
      }
      this.selectedRows = next;
      this._notifySelectionChange();
    }
    if (this.lastAnchorRow !== null) {
      if (this.lastAnchorRow === idx) this.lastAnchorRow = null;
      else if (this.lastAnchorRow > idx) this.lastAnchorRow -= 1;
    }
    this._updateScrollBounds();
    this.scheduleRender();
  }

  destroy() {
    this._destroyed = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._cancelNewRow();
    this.cancelEdit();
    this._closePreview();
    this.selectionDrag = null;
    this.selectedRows.clear();
    const b = this._bound;
    if (b.resize) window.removeEventListener("resize", b.resize);
    if (b.click) this.canvas.removeEventListener("click", b.click);
    if (b.dblclick) this.canvas.removeEventListener("dblclick", b.dblclick);
    if (b.mousemove) this.canvas.removeEventListener("mousemove", b.mousemove);
    if (b.mousedown) this.canvas.removeEventListener("mousedown", b.mousedown);
    if (b.wheel) this.canvas.removeEventListener("wheel", b.wheel);
    if (b.touchstart) this.canvas.removeEventListener("touchstart", b.touchstart);
    if (b.touchmove) this.canvas.removeEventListener("touchmove", b.touchmove);
    if (b.touchend) this.canvas.removeEventListener("touchend", b.touchend);
    if (b.mouseup) document.removeEventListener("mouseup", b.mouseup);
    if (b.keydown) document.removeEventListener("keydown", b.keydown);
    this.wrapper.remove();
  }
}

function openDeletePopoverForCanvas(doc) {
  pendingDeleteDoc = doc;
  pendingDeleteAnchor = null;
  const popover = $("deletePopover");
  $("deleteDocId").textContent = typeof doc._id === "object" ? formatJson(doc._id) : String(doc._id);
  // Center on screen, disable animation that conflicts with transform
  popover.style.animation = "none";
  popover.style.top = "50%";
  popover.style.left = "50%";
  popover.style.transform = "translate(-50%, -50%)";
  popover.hidden = false;
}

let pendingDeleteDoc = null;
let pendingDeleteAnchor = null;

function openDeletePopover(event, doc) {
  pendingDeleteDoc = doc;
  pendingDeleteAnchor = event.currentTarget;

  const popover = $("deletePopover");
  $("deleteDocId").textContent = typeof doc._id === "object" ? formatJson(doc._id) : String(doc._id);

  const rect = pendingDeleteAnchor.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 6}px`;
  popover.style.left = `${Math.max(8, rect.left - 80)}px`;
  popover.hidden = false;
}

function closeDeletePopover() {
  const popover = $("deletePopover");
  popover.hidden = true;
  popover.style.animation = "";
  popover.style.transform = "";
  pendingDeleteDoc = null;
  pendingDeleteAnchor = null;
}

async function handleDeleteConfirm() {
  if (!pendingDeleteDoc) return;
  const rawId = pendingDeleteDoc._id;
  const filterStr = formatJson({ _id: rawId });
  try {
    const data = await api(`${API_BASE}/api/delete`, {
      method: "POST",
      body: JSON.stringify({ filter: filterStr, many: false }),
    });
    showToast(`已删除 ${data.deletedCount || 0} 条`);
    const deletedDoc = pendingDeleteDoc;
    closeDeletePopover();
    if (canvasTable) {
      canvasTable.removeRow(deletedDoc);
    }
    state.docs = state.docs.filter((d) => d !== deletedDoc);
    $("resultsMeta").textContent = `结果条数: ${state.docs.length}`;
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderResultsSkeleton() {
  const container = $("resultsContainer");
  const meta = $("resultsMeta");
  if (!container) return;
  if (canvasTable) {
    canvasTable.destroy();
    canvasTable = null;
  }
  container.innerHTML = "";
  const skeleton = document.createElement("div");
  skeleton.className = "results-skeleton";
  for (let i = 0; i < 5; i++) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    skeleton.appendChild(row);
  }
  container.appendChild(skeleton);
  if (meta) meta.textContent = "查询中...";
}

function renderResults() {
  const container = $("resultsContainer");
  const docs = state.docs;
  const mode = $("viewMode").value;
  const meta = $("resultsMeta");
  meta.textContent = `结果条数: ${docs.length}`;

  if (canvasTable) {
    canvasTable.destroy();
    canvasTable = null;
  }
  updateBulkBar(0);

  container.innerHTML = "";
  if (!docs.length) {
    container.innerHTML = '<p class="results-empty">没有匹配数据</p>';
    return;
  }

  if (mode === "json") {
    const displayDocs = docs.map((doc) => toDisplayValue(doc));
    const pre = document.createElement("pre");
    pre.className = "result-json";
    pre.innerHTML = highlightJson(formatJson(displayDocs));
    container.appendChild(pre);
    return;
  }

  if (mode === "cards") {
    const displayDocs = docs.map((doc) => toDisplayValue(doc));
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

  // table 模式 — Canvas 渲染
  try {
    canvasTable = new CanvasTable(container, {
      docs,
      displayDocs: docs.map((d) => toDisplayValue(d)),
      onDelete: async (doc) => {
        const idDisplay = typeof doc._id === "object" ? formatJson(doc._id) : String(doc._id);
        if (!window.confirm(`确认删除该文档？\n\n${idDisplay}`)) return;
        try {
          const filterStr = formatJson({ _id: doc._id });
          const data = await api(`${API_BASE}/api/delete`, {
            method: "POST",
            body: JSON.stringify({ filter: filterStr, many: false }),
          });
          showToast(`已删除 ${data.deletedCount || 0} 条`);
          if (canvasTable) canvasTable.removeRow(doc);
          state.docs = state.docs.filter((d) => d !== doc);
          $("resultsMeta").textContent = `结果条数: ${state.docs.length}`;
        } catch (error) {
          showToast(error.message, true);
        }
      },
      onSelectionChange: (count) => updateBulkBar(count),
    });
    updateBulkBar(0);
  } catch (err) {
    console.error("[CanvasTable] creation error:", err);
    container.innerHTML = `<pre class="result-json">Canvas 渲染失败: ${err.message}\n\n${formatJson(docs.map((d) => toDisplayValue(d)))}</pre>`;
  }
}

async function saveConnectionDraft({ quiet = false } = {}) {
  const draftContext = getDraftContext();
  const { draft } = draftContext;
  if (!draft.uri) {
    throw new Error("连接字符串不能为空");
  }

  const shouldUpdateExisting = Boolean(
    draftContext.boundConnection && draft.uri === (draftContext.boundConnection.uri || ""),
  );

  const data = await api(`${API_BASE}/api/connections`, {
    method: "POST",
    body: JSON.stringify({
      id: shouldUpdateExisting ? draftContext.boundConnection.id : undefined,
      name: draft.name,
      type: draft.type || "mongo",
      uri: draft.uri,
    }),
  });

  if (data.connection?.id) {
    state.editingConnectionId = data.connection.id;
  }

  await refreshConnections();
  if (!quiet) {
    showToast("连接配置已保存");
  }
  return data.connection;
}

async function handleConnectionSelect(connectionId) {
  await api(`${API_BASE}/api/connections/${connectionId}/select`, {
    method: "POST",
    body: "{}",
  });
  state.editingConnectionId = connectionId;
  await refreshConnections();
  await loadConnectionResources();
}

async function handleConnectSavedConnection(connectionId) {
  if (state.connecting) return;
  setConnecting(true);
  try {
    const data = await api(`${API_BASE}/api/connections/${connectionId}/connect`, {
      method: "POST",
      body: "{}",
    });
    state.editingConnectionId = connectionId;
    setStatus(data.status);
    if (data.status?.uri) {
      $("uriInput").value = data.status.uri;
    }
    await refreshConnections();
    const [dbResult, collectionResult] = await Promise.all([
      refreshDatabases({ suppressError: true }),
      refreshCollections({ suppressError: true }),
    ]);

    const notices = [];
    if (data.adapted && data.adaptationReason) {
      notices.push(`已自动适配参数（${data.adaptationReason}）`);
    }
    const warnings = [dbResult.warning, collectionResult.warning].filter(Boolean);
    if (warnings.length) {
      notices.push(`部分列表不可见：${warnings[0]}`);
    }

    showToast(notices.length ? `连接成功，${notices.join("；")}` : "连接成功");
  } catch (err) {
    showToast(`连接失败：${err.message}`, true);
  } finally {
    setConnecting(false);
  }
}

async function handleDisconnectConnection(connectionId) {
  if (state.connecting) return;
  setConnecting(true);
  try {
    const data = await api(`${API_BASE}/api/connections/${connectionId}/disconnect`, {
      method: "POST",
      body: "{}",
    });
    setStatus(data.status);
    await refreshConnections({ preserveDraft: connectionId !== state.editingConnectionId });
    await loadConnectionResources();
    showToast("已断开连接");
  } catch (err) {
    showToast(`断开失败：${err.message}`, true);
  } finally {
    setConnecting(false);
  }
}

async function handleDeleteConnection(connectionId) {
  const connection = findSavedConnection(connectionId);
  const accepted = window.confirm(
    `确认删除连接配置“${connection?.name || "未命名连接"}”吗？`,
  );
  if (!accepted) {
    return;
  }

  const data = await api(`${API_BASE}/api/connections/${connectionId}`, {
    method: "DELETE",
  });

  if (state.editingConnectionId === connectionId) {
    state.editingConnectionId = null;
  }

  setStatus(data.status);
  await refreshConnections({ fallbackToActive: true });
  await loadConnectionResources();
  showToast("连接配置已删除");
}

async function handleNewConnectionDraft() {
  state.editingConnectionId = null;
  clearConnectionDraft();
  renderConnectionList();
  renderStatusChip(state.status || { connected: false, dbName: "", collectionName: "" });
  updateConnectToggle(state.status);
}

function readQueryPayload() {
  const isSql =
    state.status?.driverType === "postgres" || state.status?.driverType === "mysql";
  if (isSql) {
    return {
      where: $("queryFilter").value.trim(),
      projection: $("queryProjection").value.trim(),
      orderBy: $("querySort").value.trim(),
      limit: Number($("queryLimit").value || 20),
    };
  }
  return {
    filter: $("queryFilter").value.trim(),
    projection: $("queryProjection").value.trim(),
    sort: $("querySort").value.trim(),
    limit: Number($("queryLimit").value || 20),
  };
}

async function connectUsingCurrentInput() {
  const connection = await saveConnectionDraft({ quiet: true });
  if (!connection?.id) {
    throw new Error("连接配置保存失败");
  }
  await handleConnectSavedConnection(connection.id);
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
  const currentId = activeConnectionId();
  if (!currentId) {
    throw new Error("当前没有可断开的连接");
  }
  await handleDisconnectConnection(currentId);
}

async function handleConnectToggle() {
  const draftContext = getDraftContext();

  if (draftContext.canDisconnectActive) {
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
  // kept for compatibility - tree handles db switching now
}

async function handleSetCollection() {
  // kept for compatibility - tree handles collection switching now
}

async function handleQuery() {
  await runWithLoading("query", "runQueryBtn", "查询中...", async () => {
    renderResultsSkeleton();
    try {
      const payload = readQueryPayload();
      const data = await api(`${API_BASE}/api/query`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.docs = data.docs;
      showToast(`查询完成: ${data.count} 条`);
    } finally {
      renderResults();
    }
  });
}

async function handleInsert() {
  await runWithLoading("insert", "insertBtn", "插入中...", async () => {
    const doc = $("insertDoc").value.trim();
    const data = await api(`${API_BASE}/api/insert`, {
      method: "POST",
      body: JSON.stringify({ doc }),
    });
    const isSql =
      state.status?.driverType === "postgres" || state.status?.driverType === "mysql";
    if (isSql) {
      showToast(`插入成功: ${data.inserted || 0} 行`);
    } else {
      showToast(`插入成功: ${JSON.stringify(data.insertedId)}`);
    }
  });
}

async function handleUpdate() {
  await runWithLoading("update", "updateBtn", "更新中...", async () => {
    const isSql =
      state.status?.driverType === "postgres" || state.status?.driverType === "mysql";
    const body = isSql
      ? {
          where: $("updateFilter").value.trim(),
          setDoc: $("updateDoc").value.trim(),
        }
      : {
          filter: $("updateFilter").value.trim(),
          update: $("updateDoc").value.trim(),
          many: $("updateMany").checked,
          upsert: $("updateUpsert").checked,
        };
    const data = await api(`${API_BASE}/api/update`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (isSql) {
      showToast(`更新完成: ${data.updated || 0} 行`);
    } else {
      showToast(`更新完成: matched ${data.matchedCount}, modified ${data.modifiedCount}`);
    }
  });
}

async function handleDelete() {
  const accepted = window.confirm("确认执行删除操作？");
  if (!accepted) {
    return;
  }
  await runWithLoading("delete", "deleteBtn", "删除中...", async () => {
    const isSql =
      state.status?.driverType === "postgres" || state.status?.driverType === "mysql";
    const body = isSql
      ? { where: $("deleteFilter").value.trim() }
      : { filter: $("deleteFilter").value.trim(), many: $("deleteMany").checked };
    const data = await api(`${API_BASE}/api/delete`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    showToast(`删除完成: ${isSql ? data.deleted : data.deletedCount} 条`);
  });
}

async function handleStats() {
  const data = await api(`${API_BASE}/api/stats`);
  $("statsOutput").textContent = formatJson(data.stats);
  showToast("统计已刷新");
}

async function handleExport() {
  const payload = {
    ...readQueryPayload(),
    format: $("exportFormat").value,
  };

  const response = await fetch(`${API_BASE}/api/export`, {
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

function updateBulkBar(count) {
  const bar = $("bulkActionBar");
  if (!bar) return;
  if (count > 0) {
    bar.hidden = false;
    $("bulkCount").textContent = String(count);
  } else {
    bar.hidden = true;
  }
}

function getSelectedDocsFromCanvas() {
  if (!canvasTable) return [];
  return canvasTable.getSelectedDocs();
}

async function handleBulkCopyId() {
  const docs = getSelectedDocsFromCanvas();
  if (!docs.length) {
    showToast("未选择任何行", true);
    return;
  }
  const ids = docs.map((d) => d._id);
  const text = ids.length === 1 ? formatJson(ids[0]) : formatJson(ids);
  try {
    await navigator.clipboard.writeText(text);
    showToast(`已复制 ${ids.length} 个 _id`);
  } catch (err) {
    // Fallback for non-secure contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast(`已复制 ${ids.length} 个 _id`);
    } catch (e) {
      showToast("复制失败：浏览器不支持", true);
    }
    ta.remove();
  }
}

function bulkDocsToCsv(docs) {
  if (!docs.length) return "";
  const keys = [...new Set(docs.flatMap((doc) => Object.keys(doc)))];
  const esc = (value) => {
    if (value === undefined || value === null) return "";
    const text =
      typeof value === "string" ? value : formatJson(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  const lines = docs.map((doc) => keys.map((key) => esc(doc[key])).join(","));
  return `${keys.join(",")}\n${lines.join("\n")}\n`;
}

async function handleBulkExport() {
  const docs = getSelectedDocsFromCanvas();
  if (!docs.length) {
    showToast("未选择任何行", true);
    return;
  }
  const format = $("exportFormat").value || "json";
  const displayDocs = docs.map((d) => toDisplayValue(d));
  let content = "";
  let mime = "text/plain; charset=utf-8";
  let ext = format;
  if (format === "json") {
    mime = "application/json; charset=utf-8";
    content = formatJson(displayDocs);
  } else if (format === "yaml") {
    mime = "application/x-yaml; charset=utf-8";
    content = docsToYaml(displayDocs);
  } else if (format === "csv") {
    mime = "text/csv; charset=utf-8";
    content = bulkDocsToCsv(displayDocs);
    ext = "csv";
  } else if (format === "ndjson") {
    mime = "application/x-ndjson; charset=utf-8";
    content = displayDocs.map((d) => JSON.stringify(d)).join("\n");
    ext = "ndjson";
  } else {
    content = formatJson(displayDocs);
    ext = "json";
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `selected_${stamp}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${docs.length} 行 → ${ext.toUpperCase()}`);
}

function docsToYaml(docs) {
  // Minimal YAML emitter for selected-docs export (no external dep).
  // Supports nested objects, arrays, strings, numbers, booleans, null.
  const lines = [];
  const quoteScalar = (val) => {
    if (val === null || val === undefined) return "null";
    if (typeof val === "number") return Number.isFinite(val) ? String(val) : "null";
    if (typeof val === "boolean") return val ? "true" : "false";
    if (typeof val === "string") {
      if (val === "" || /[:#{}\[\],&*?|\-<>=!%@`"\n]/.test(val) || /^\s|\s$/.test(val)) {
        return JSON.stringify(val);
      }
      return val;
    }
    return JSON.stringify(val);
  };
  const emit = (value, indent) => {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${indent}[]`);
        return;
      }
      for (const item of value) {
        if (item !== null && typeof item === "object") {
          lines.push(`${indent}-`);
          emit(item, indent + "  ");
        } else {
          lines.push(`${indent}- ${quoteScalar(item)}`);
        }
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        lines.push(`${indent}{}`);
        return;
      }
      for (const [k, v] of entries) {
        if (v !== null && typeof v === "object") {
          lines.push(`${indent}${k}:`);
          emit(v, indent + "  ");
        } else {
          lines.push(`${indent}${k}: ${quoteScalar(v)}`);
        }
      }
      return;
    }
    lines.push(`${indent}${quoteScalar(value)}`);
  };
  if (Array.isArray(docs)) {
    emit(docs, "");
  } else {
    emit(docs, "");
  }
  return lines.join("\n") + "\n";
}

async function handleBulkDelete() {
  const docs = getSelectedDocsFromCanvas();
  if (!docs.length) {
    showToast("未选择任何行", true);
    return;
  }
  const sampleIds = docs
    .slice(0, 3)
    .map((d, i) => {
      const id = typeof d._id === "object" ? formatJson(d._id) : String(d._id);
      return `  ${i + 1}. ${id}`;
    })
    .join("\n");
  const more = docs.length > 3 ? `\n  ...（共 ${docs.length} 条）` : "";
  const message =
    docs.length === 1
      ? `确认删除以下文档？\n\n${sampleIds}`
      : `确认删除以下 ${docs.length} 个文档？此操作不可撤销。\n\n${sampleIds}${more}`;
  if (!window.confirm(message)) return;

  const ids = docs.map((d) => d._id);
  const filterStr = formatJson({ _id: { $in: ids } });
  try {
    const data = await api(`${API_BASE}/api/delete`, {
      method: "POST",
      body: JSON.stringify({ filter: filterStr, many: true }),
    });
    const deletedCount = data.deletedCount || 0;
    showToast(`已删除 ${deletedCount} 条`);
    // Remove all selected rows locally
    if (canvasTable) {
      const selectedSet = new Set(canvasTable.selectedRows);
      // Remove in descending order so indices stay valid
      const rowsToRemove = [...selectedSet].sort((a, b) => b - a);
      for (const r of rowsToRemove) {
        const doc = canvasTable.docs[r];
        if (doc) canvasTable.removeRow(doc);
      }
      canvasTable.clearSelection();
    }
    const removedSet = new Set(docs);
    state.docs = state.docs.filter((d) => !removedSet.has(d));
    $("resultsMeta").textContent = `结果条数: ${state.docs.length}`;
  } catch (error) {
    showToast(error.message, true);
  }
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
    const data = await api(`${API_BASE}/api/command`, {
      method: "POST",
      body: JSON.stringify({ command }),
    });

    if (data.status) {
      setStatus(data.status);
      syncUiByStatus(data.status);
      await refreshCollections({ suppressError: true });
      renderDbTree();
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
  $("connectForm").addEventListener("submit", wrap(handleConnect));
  $("saveConnectionBtn").addEventListener("click", wrap(() => saveConnectionDraft()));
  $("newConnectionBtn").addEventListener("click", () => {
    void handleNewConnectionDraft();
  });
  ["connectionNameInput", "uriInput"].forEach((id) => {
    $(id).addEventListener("input", () => {
      renderConnectionList();
      renderStatusChip(state.status || { connected: false, dbName: "", collectionName: "" });
      updateConnectToggle(state.status);
    });
  });
  $("connectionTypeInput").addEventListener("change", (e) => {
    const type = e.target.value || "mongo";
    applyUriPlaceholder(type);
    // 切换类型：输入框为空、或匹配某类型默认值时，自动带出该类型最近用过的连接串；没有则用内置默认（仅 mongo）；都没有则留空
    const cur = $("uriInput").value.trim();
    const isDefault = Object.values(DEFAULT_URIS).includes(cur);
    if (!isDefault && cur) {
      renderConnectionList();
      return;
    }
    const latest = findLatestConnectionOfType(type);
    $("uriInput").value = latest ? latest.uri : DEFAULT_URIS[type];
    renderConnectionList();
  });
  $("sidebarToggleBtn").addEventListener("click", () => {
    const next = !document.body.classList.contains("sidebar-collapsed");
    applySidebarCollapsed(next);
  });

  // Mobile: backdrop click closes sidebar
  $("sidebarBackdrop").addEventListener("click", () => {
    applySidebarCollapsed(true);
  });

  $("connectToggleBtn").addEventListener("click", wrap(handleConnectToggle));
  $("refreshDbBtn").addEventListener("click", wrap(async () => { await refreshDatabases(); renderDbTree(); }));

  document.addEventListener("click", (event) => {
    const viewSelectRoot = $("viewModePicker");
    const exportSelectRoot = $("exportFormatPicker");
    if (viewSelectRoot && !viewSelectRoot.contains(event.target)) {
      closeQuerySelect("viewMode");
    }
    if (exportSelectRoot && !exportSelectRoot.contains(event.target)) {
      closeQuerySelect("exportFormat");
    }
    const popover = $("deletePopover");
    if (popover && !popover.hidden && !popover.contains(event.target) && !event.target.closest(".action-delete")) {
      closeDeletePopover();
    }
    // Close index context menu on outside click
    const indexMenu = $("indexContextMenu");
    if (indexMenu && !indexMenu.hidden && !indexMenu.contains(event.target)) {
      closeIndexContextMenu();
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
  $("builderCollapseBtn").addEventListener("click", () => {
    applyQueryInputCollapsed(!state.queryInputCollapsed);
  });
  $("terminalCollapseBtn").addEventListener("click", () => {
    applyQueryInputCollapsed(!state.queryInputCollapsed);
  });
  $("viewMode").addEventListener("change", renderResults);
  $("exportBtn").addEventListener("click", wrap(handleExport));

  $("bulkSelectAllBtn").addEventListener("click", () => {
    if (!canvasTable) return;
    if (canvasTable.selectedRows.size > 0) canvasTable.clearSelection();
    else canvasTable.selectAll();
  });
  $("bulkClearBtn").addEventListener("click", () => {
    if (canvasTable) canvasTable.clearSelection();
  });
  $("bulkCopyIdBtn").addEventListener("click", wrap(handleBulkCopyId));
  $("bulkExportBtn").addEventListener("click", wrap(handleBulkExport));
  $("bulkDeleteBtn").addEventListener("click", wrap(handleBulkDelete));

  $("insertBtn").addEventListener("click", wrap(handleInsert));
  $("updateBtn").addEventListener("click", wrap(handleUpdate));
  $("deleteBtn").addEventListener("click", wrap(handleDelete));
  $("statsBtn").addEventListener("click", wrap(handleStats));

  // delete popover
  $("deleteCancelBtn").addEventListener("click", closeDeletePopover);
  $("deleteConfirmBtn").addEventListener("click", wrap(handleDeleteConfirm));

  // index context menu close
  $("indexContextMenuClose").addEventListener("click", closeIndexContextMenu);
  document.querySelectorAll(".context-menu-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const next = tab.dataset.cmTab;
      if (!next || next === contextMenuState.activeTab) return;
      document.querySelectorAll(".context-menu-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
      });
      void loadContextMenuTab(next);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeIndexContextMenu();
  });

  const logoutBtn = $("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await fetch(`${API_BASE}/api/logout`, { method: "POST" });
      } catch {
        // ignore — cookie cleared server-side best-effort
      }
      location.href = "/login";
    });
  }

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
      const variants = error?.payload?.triedVariants;
      if (Array.isArray(variants) && variants.length > 1) {
        const reasons = variants.map((v) => v.reason).join("、");
        showToast(error.message, true, {
          duration: 5500,
          detail: `已尝试 ${variants.length} 种方式：${reasons}`,
        });
      } else {
        showToast(error.message, true);
      }
    }
  };
}

async function init() {
  setupTabs();
  const activeTab = document.querySelector(".tab.active")?.dataset.tab || "query";
  setActiveTab(activeTab);
  initSidebarCollapseState();
  bindEvents();
  setupTreeSearch();
  applyQueryInputMode(getSavedQueryInputMode(), { persist: false });
  applyQueryInputCollapsed(getSavedQueryInputCollapsed(), { persist: false });
  renderTerminalContext();
  setTerminalRunning(false);
  clearConnectionDraft();
  await refreshStatus();
  await refreshConnections({ fallbackToActive: true });
  await loadConnectionResources();
  renderDbTree();
  renderResults();

  const s = state.status;
  if (s?.activeConnectionId && !s?.connected) {
    showToast("上次会话的连接未恢复，请点击「连接」按钮重新建立", false, {
      duration: 4500,
    });
  }

  history.replaceState(null, "", location.href);
  window.addEventListener("popstate", () => {
    history.pushState(null, "", location.href);
  });

  document.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.preventDefault();
    },
    { passive: false, capture: true }
  );
}

init().catch((error) => showToast(error.message, true));
