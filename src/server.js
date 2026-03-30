#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import yaml from "js-yaml";
import { EJSON } from "bson";
import { MongoClient } from "mongodb";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const state = {
  client: null,
  uri: "",
  dbName: "",
  collectionName: "",
};

const asyncHandler =
  (fn) =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

function toTransport(value) {
  return JSON.parse(EJSON.stringify(value, { relaxed: false }));
}

function parseEjsonInput(input, fallback = undefined) {
  if (input === undefined || input === null || input === "") {
    return fallback;
  }

  if (typeof input === "object") {
    return input;
  }

  if (typeof input !== "string") {
    throw new Error("参数必须是 JSON/EJSON 字符串或对象");
  }

  return EJSON.parse(input.trim());
}

function assertConnected() {
  if (!state.client) {
    const error = new Error("MongoDB 未连接");
    error.statusCode = 400;
    throw error;
  }
}

function assertDbSelected() {
  assertConnected();
  if (!state.dbName) {
    const error = new Error("请先选择数据库");
    error.statusCode = 400;
    throw error;
  }
}

function getCollection() {
  assertDbSelected();
  if (!state.collectionName) {
    const error = new Error("请先选择集合");
    error.statusCode = 400;
    throw error;
  }

  return state.client.db(state.dbName).collection(state.collectionName);
}

function getStatus() {
  return {
    connected: Boolean(state.client),
    uri: state.uri,
    dbName: state.dbName,
    collectionName: state.collectionName,
  };
}

function toCsv(docs) {
  if (!docs.length) {
    return "";
  }

  const keys = [...new Set(docs.flatMap((doc) => Object.keys(doc)))];
  const esc = (value) => {
    if (value === undefined) {
      return "";
    }
    const text =
      typeof value === "string" ? value : EJSON.stringify(value, { relaxed: false });
    return `"${text.replaceAll('"', '""')}"`;
  };

  const lines = docs.map((doc) => keys.map((k) => esc(doc[k])).join(","));
  return `${keys.join(",")}\n${lines.join("\n")}\n`;
}

async function closeCurrentClient() {
  if (state.client) {
    await state.client.close();
    state.client = null;
  }
}

function normalizeErrorMessage(error) {
  const raw = error?.message || "未知错误";
  if (raw.includes("ECONNREFUSED")) {
    return "连接被拒绝，请确认 MongoDB 服务已启动且端口可访问。";
  }
  if (raw.includes("ENOTFOUND")) {
    return "无法解析主机名，请检查连接字符串中的域名是否正确。";
  }
  if (raw.toLowerCase().includes("authentication failed")) {
    return "认证失败，请检查用户名、密码和 authSource 配置。";
  }
  if (raw.toLowerCase().includes("timed out")) {
    return "连接超时，请检查网络、白名单或 MongoDB 地址。";
  }
  return raw;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, status: getStatus() });
});

app.post(
  "/api/connect",
  asyncHandler(async (req, res) => {
    const uri = String(req.body?.uri || "").trim();
    if (!uri) {
      return res.status(400).json({ ok: false, error: "连接字符串不能为空" });
    }

    await closeCurrentClient();
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    await client.db().command({ ping: 1 });

    state.client = client;
    state.uri = uri;
    state.dbName = client.db().databaseName || "";
    state.collectionName = "";

    res.json({ ok: true, status: getStatus() });
  }),
);

app.post(
  "/api/disconnect",
  asyncHandler(async (_req, res) => {
    await closeCurrentClient();
    state.uri = "";
    state.dbName = "";
    state.collectionName = "";
    res.json({ ok: true, status: getStatus() });
  }),
);

app.get("/api/status", (_req, res) => {
  res.json({ ok: true, status: getStatus() });
});

app.get(
  "/api/databases",
  asyncHandler(async (_req, res) => {
    assertConnected();
    try {
      const list = await state.client.db("admin").admin().listDatabases();
      const databases = list.databases
        .map((db) => ({ name: db.name, sizeOnDisk: db.sizeOnDisk }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.json({ ok: true, databases, warning: null });
    } catch (error) {
      const fallbackDb = state.client.db().databaseName || "test";
      return res.json({
        ok: true,
        databases: [{ name: fallbackDb, sizeOnDisk: null }],
        warning: `无法列出数据库，请手动输入数据库名。原因: ${error.message}`,
      });
    }
  }),
);

app.post(
  "/api/database",
  asyncHandler(async (req, res) => {
    assertConnected();
    const dbName = String(req.body?.dbName || "").trim();
    if (!dbName) {
      return res.status(400).json({ ok: false, error: "数据库名不能为空" });
    }

    state.dbName = dbName;
    state.collectionName = "";

    let collections = [];
    let warning = null;
    try {
      const result = await state.client.db(state.dbName).listCollections().toArray();
      collections = result.map((c) => c.name).sort((a, b) => a.localeCompare(b));
    } catch (error) {
      warning = `无法列出集合，请手动输入集合名。原因: ${error.message}`;
    }

    res.json({
      ok: true,
      status: getStatus(),
      collections,
      warning,
    });
  }),
);

app.get(
  "/api/collections",
  asyncHandler(async (_req, res) => {
    assertDbSelected();
    let collections = [];
    let warning = null;
    try {
      collections = await state.client.db(state.dbName).listCollections().toArray();
    } catch (error) {
      warning = `无法列出集合，请手动输入集合名。原因: ${error.message}`;
    }

    res.json({
      ok: true,
      collections: collections.map((c) => c.name).sort((a, b) => a.localeCompare(b)),
      warning,
    });
  }),
);

app.post("/api/collection", (req, res) => {
  assertDbSelected();
  const collectionName = String(req.body?.collectionName || "").trim();
  if (!collectionName) {
    return res.status(400).json({ ok: false, error: "集合名不能为空" });
  }
  state.collectionName = collectionName;
  res.json({ ok: true, status: getStatus() });
});

app.post(
  "/api/query",
  asyncHandler(async (req, res) => {
    const collection = getCollection();
    const filter = parseEjsonInput(req.body?.filter, {});
    const projection = parseEjsonInput(req.body?.projection, undefined);
    const sort = parseEjsonInput(req.body?.sort, undefined);
    const limitRaw = Number(req.body?.limit ?? 20);
    const limit = Number.isInteger(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 500)
      : 20;

    const cursor = collection.find(filter);
    if (projection) {
      cursor.project(projection);
    }
    if (sort) {
      cursor.sort(sort);
    }

    const docs = await cursor.limit(limit).toArray();
    res.json({ ok: true, count: docs.length, docs: toTransport(docs) });
  }),
);

app.post(
  "/api/insert",
  asyncHandler(async (req, res) => {
    const collection = getCollection();
    const doc = parseEjsonInput(req.body?.doc);
    if (!doc || Array.isArray(doc) || typeof doc !== "object") {
      return res.status(400).json({ ok: false, error: "插入内容必须是对象类型文档" });
    }
    const result = await collection.insertOne(doc);
    res.json({
      ok: true,
      insertedId: toTransport(result.insertedId),
    });
  }),
);

app.post(
  "/api/update",
  asyncHandler(async (req, res) => {
    const collection = getCollection();
    const filter = parseEjsonInput(req.body?.filter, {});
    const many = Boolean(req.body?.many);
    const upsert = Boolean(req.body?.upsert);
    let update = parseEjsonInput(req.body?.update);

    if (!update || Array.isArray(update) || typeof update !== "object") {
      return res.status(400).json({ ok: false, error: "更新内容必须是对象" });
    }

    const hasOperator = Object.keys(update).some((key) => key.startsWith("$"));
    if (!hasOperator) {
      update = { $set: update };
    }

    const result = many
      ? await collection.updateMany(filter, update, { upsert })
      : await collection.updateOne(filter, update, { upsert });
    res.json({
      ok: true,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedCount: result.upsertedCount,
    });
  }),
);

app.post(
  "/api/delete",
  asyncHandler(async (req, res) => {
    const collection = getCollection();
    const filter = parseEjsonInput(req.body?.filter, {});
    const many = Boolean(req.body?.many);
    const result = many
      ? await collection.deleteMany(filter)
      : await collection.deleteOne(filter);
    res.json({ ok: true, deletedCount: result.deletedCount });
  }),
);

app.get(
  "/api/stats",
  asyncHandler(async (_req, res) => {
    const collection = getCollection();
    const [estimatedCount, accurateCount, indexes] = await Promise.all([
      collection.estimatedDocumentCount(),
      collection.countDocuments(),
      collection.indexes(),
    ]);

    let collStats = null;
    try {
      collStats = await state.client
        .db(state.dbName)
        .command({ collStats: state.collectionName, scale: 1 });
    } catch {
      collStats = null;
    }

    res.json({
      ok: true,
      stats: {
        estimatedCount,
        accurateCount,
        indexCount: indexes.length,
        storageSize: collStats?.storageSize ?? null,
        avgObjSize: collStats?.avgObjSize ?? null,
        totalIndexSize: collStats?.totalIndexSize ?? null,
      },
    });
  }),
);

app.post(
  "/api/export",
  asyncHandler(async (req, res) => {
    const collection = getCollection();
    const filter = parseEjsonInput(req.body?.filter, {});
    const projection = parseEjsonInput(req.body?.projection, undefined);
    const sort = parseEjsonInput(req.body?.sort, undefined);
    const format = String(req.body?.format || "json");
    const limitRaw = Number(req.body?.limit ?? 100);
    const limit = Number.isInteger(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 5000)
      : 100;

    const cursor = collection.find(filter);
    if (projection) {
      cursor.project(projection);
    }
    if (sort) {
      cursor.sort(sort);
    }

    const docs = await cursor.limit(limit).toArray();

    let filename = `${state.dbName}_${state.collectionName}_${Date.now()}.${format}`;
    let mimeType = "text/plain; charset=utf-8";
    let content = "";

    if (format === "json") {
      mimeType = "application/json; charset=utf-8";
      content = EJSON.stringify(docs, { relaxed: false, indent: 2 });
    } else if (format === "yaml") {
      mimeType = "application/x-yaml; charset=utf-8";
      content = yaml.dump(JSON.parse(EJSON.stringify(docs, { relaxed: true })));
    } else if (format === "csv") {
      mimeType = "text/csv; charset=utf-8";
      content = toCsv(docs);
    } else if (format === "ndjson") {
      mimeType = "application/x-ndjson; charset=utf-8";
      content = docs.map((doc) => EJSON.stringify(doc, { relaxed: false })).join("\n");
    } else {
      filename = `${state.dbName}_${state.collectionName}_${Date.now()}.txt`;
      content = EJSON.stringify(docs, { relaxed: false, indent: 2 });
    }

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(content);
  }),
);

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    ok: false,
    error: normalizeErrorMessage(error),
  });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`MongoDB Admin Web 已启动: http://localhost:${port}`);
});

async function gracefulShutdown() {
  await closeCurrentClient();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
