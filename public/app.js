const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  docs: [],
};

const comboState = {
  db: { options: [], filtered: [], open: false, highlighted: -1 },
  collection: { options: [], filtered: [], open: false, highlighted: -1 },
};

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.style.background = isError ? "#6b2a23" : "#1f1b18";
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function compact(value, max = 80) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (!raw) {
    return "";
  }
  return raw.length > max ? `${raw.slice(0, max)}...` : raw;
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

  const chip = $("statusChip");
  chip.textContent = status.connected
    ? `已连接: ${status.dbName || "(未选库)"} / ${status.collectionName || "(未选集合)"}`
    : "未连接";
  chip.classList.toggle("connected", status.connected);

  $("statusText").textContent = formatJson(status);
  updateConnectToggle(status);
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

  const isConnected = Boolean(status?.connected);
  const icon = connectToggleIconPath(isConnected);
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
    pre.textContent = formatJson(docs);
    container.appendChild(pre);
    return;
  }

  if (mode === "cards") {
    const grid = document.createElement("div");
    grid.className = "card-grid";
    docs.forEach((doc, index) => {
      const card = document.createElement("article");
      card.className = "doc-card";
      card.innerHTML = `
        <h3>Document #${index + 1}</h3>
        <pre>${formatJson(doc)}</pre>
      `;
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
  docs.forEach((doc) => {
    const tr = document.createElement("tr");
    keys.forEach((k) => {
      const td = document.createElement("td");
      td.textContent = compact(doc[k], 120);
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
  const dbResult = await refreshDatabases({ suppressError: true });
  const collectionResult = await refreshCollections({ suppressError: true });

  const warnings = [dbResult.warning, collectionResult.warning].filter(Boolean);
  if (warnings.length) {
    showToast(`连接成功，但部分列表不可见：${warnings[0]}`);
    return;
  }

  showToast("连接成功");
}

async function handleConnect(event) {
  event.preventDefault();
  await connectUsingCurrentInput();
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
  await connectUsingCurrentInput();
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

function setupTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.tab;
      document.querySelectorAll(".tab-content").forEach((section) => {
        section.classList.toggle("active", section.id === `tab-${target}`);
      });
    });
  });
}

function bindEvents() {
  const runSetDb = wrap(handleSetDb);
  const runSetCollection = wrap(handleSetCollection);

  $("connectForm").addEventListener("submit", wrap(handleConnect));
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
    if (!dbField.contains(event.target)) {
      closeCombo("db");
    }
    if (!collectionField.contains(event.target)) {
      closeCombo("collection");
    }
  });

  $("runQueryBtn").addEventListener("click", wrap(handleQuery));
  $("viewMode").addEventListener("change", renderResults);
  $("exportBtn").addEventListener("click", wrap(handleExport));

  $("insertBtn").addEventListener("click", wrap(handleInsert));
  $("updateBtn").addEventListener("click", wrap(handleUpdate));
  $("deleteBtn").addEventListener("click", wrap(handleDelete));
  $("statsBtn").addEventListener("click", wrap(handleStats));
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
  bindEvents();
  await refreshStatus();
  await refreshDatabases({ suppressError: true });
  await refreshCollections({ suppressError: true });
  renderResults();
}

init().catch((error) => showToast(error.message, true));
