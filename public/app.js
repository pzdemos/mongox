const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  docs: [],
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
}

function fillSelect(selectEl, values, placeholder) {
  selectEl.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = placeholder;
  selectEl.appendChild(opt);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  }
}

async function refreshStatus() {
  const data = await api("/api/status");
  setStatus(data.status);
}

async function refreshDatabases({ suppressError = false } = {}) {
  if (!state.status?.connected) {
    fillSelect($("dbSelect"), [], "先连接数据库");
    return { warning: null };
  }
  try {
    const data = await api("/api/databases");
    fillSelect(
      $("dbSelect"),
      data.databases.map((d) => d.name),
      "选择数据库",
    );
    return { warning: data.warning || null };
  } catch (error) {
    fillSelect($("dbSelect"), [], "手动输入数据库名");
    if (!suppressError) {
      throw error;
    }
    return { warning: error.message };
  }
}

async function refreshCollections({ suppressError = false } = {}) {
  if (!state.status?.connected || !state.status?.dbName) {
    fillSelect($("collectionSelect"), [], "先选择数据库");
    return { warning: null };
  }
  try {
    const data = await api("/api/collections");
    fillSelect($("collectionSelect"), data.collections, "选择集合");
    return { warning: data.warning || null };
  } catch (error) {
    fillSelect($("collectionSelect"), [], "手动输入集合名");
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

async function handleConnect(event) {
  event.preventDefault();
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

async function handleDisconnect() {
  const data = await api("/api/disconnect", { method: "POST", body: "{}" });
  setStatus(data.status);
  fillSelect($("dbSelect"), [], "先连接数据库");
  fillSelect($("collectionSelect"), [], "先选择数据库");
  state.docs = [];
  renderResults();
  showToast("已断开连接");
}

async function handleSetDb() {
  const dbName = $("dbInput").value.trim() || $("dbSelect").value;
  if (!dbName) {
    throw new Error("请输入或选择数据库名");
  }
  const data = await api("/api/database", {
    method: "POST",
    body: JSON.stringify({ dbName }),
  });
  setStatus(data.status);
  fillSelect($("collectionSelect"), data.collections, "选择集合");
  if (data.warning) {
    showToast(data.warning);
    return;
  }
  showToast(`数据库已切换: ${dbName}`);
}

async function handleSetCollection() {
  const collectionName =
    $("collectionInput").value.trim() || $("collectionSelect").value;
  if (!collectionName) {
    throw new Error("请输入或选择集合名");
  }
  const data = await api("/api/collection", {
    method: "POST",
    body: JSON.stringify({ collectionName }),
  });
  setStatus(data.status);
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
  $("connectForm").addEventListener("submit", wrap(handleConnect));
  $("disconnectBtn").addEventListener("click", wrap(handleDisconnect));
  $("refreshDbBtn").addEventListener("click", wrap(refreshDatabases));
  $("refreshCollectionBtn").addEventListener("click", wrap(refreshCollections));
  $("setDbBtn").addEventListener("click", wrap(handleSetDb));
  $("setCollectionBtn").addEventListener("click", wrap(handleSetCollection));

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
