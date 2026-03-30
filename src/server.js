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

function parseMongoUri(uri) {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function isAuthFailure(error) {
  const raw = (error?.message || "").toLowerCase();
  return (
    raw.includes("authentication failed") ||
    raw.includes("bad auth") ||
    raw.includes("sasl") ||
    raw.includes("auth failed")
  );
}

function buildDirectConnectionVariant(uri) {
  const parsed = parseMongoUri(uri);
  if (!parsed || parsed.host.includes(",")) {
    return null;
  }
  if (parsed.searchParams.get("directConnection") === "true") {
    return null;
  }

  const next = new URL(parsed.toString());
  next.searchParams.set("directConnection", "true");
  return {
    uri: next.toString(),
    reason: "自动追加 directConnection=true",
  };
}

function buildAuthAdaptiveVariants(uri) {
  const parsed = parseMongoUri(uri);
  if (!parsed || !parsed.username) {
    return [];
  }

  const dbName = decodeURIComponent((parsed.pathname || "").replace(/^\//, "")).trim();
  const currentAuthSource = parsed.searchParams.get("authSource");
  const currentMechanism = parsed.searchParams.get("authMechanism");

  const authSources = [...new Set([dbName, currentAuthSource, "admin"].filter(Boolean))];
  const mechanisms = [
    ...new Set([currentMechanism, "SCRAM-SHA-1", "SCRAM-SHA-256"].filter(Boolean)),
  ];

  const variants = [];
  const pushVariant = (nextUri, reason) => {
    variants.push({ uri: nextUri, reason });
  };

  authSources.forEach((authSource) => {
    const withAuthSource = new URL(parsed.toString());
    withAuthSource.searchParams.set("authSource", authSource);
    if (!withAuthSource.host.includes(",")) {
      withAuthSource.searchParams.set("directConnection", "true");
    }
    pushVariant(withAuthSource.toString(), `自动切换 authSource=${authSource}`);

    mechanisms.forEach((mechanism) => {
      const withMechanism = new URL(withAuthSource.toString());
      withMechanism.searchParams.set("authMechanism", mechanism);
      pushVariant(
        withMechanism.toString(),
        `自动切换 authSource=${authSource}, authMechanism=${mechanism}`,
      );
    });
  });

  return variants;
}

async function connectWithUri(uri, timeoutMS = 10000) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMS });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

async function connectWithAdaptiveRetry(uri) {
  const tried = new Set();
  let lastError = null;

  const tryConnect = async ({ uri: candidateUri, reason }, timeoutMS) => {
    if (!candidateUri || tried.has(candidateUri)) {
      return null;
    }
    tried.add(candidateUri);

    try {
      const client = await connectWithUri(candidateUri, timeoutMS);
      return { client, uri: candidateUri, reason };
    } catch (error) {
      lastError = error;
      return null;
    }
  };

  const primary = await tryConnect(
    { uri, reason: "使用原始连接字符串" },
    10000,
  );
  if (primary) {
    return { ...primary, adapted: false };
  }

  const candidates = [];
  const directVariant = buildDirectConnectionVariant(uri);
  if (directVariant) {
    candidates.push(directVariant);
  }

  if (isAuthFailure(lastError)) {
    candidates.push(...buildAuthAdaptiveVariants(uri));
  } else {
    candidates.push(...buildAuthAdaptiveVariants(uri).slice(0, 4));
  }

  for (const candidate of candidates) {
    const result = await tryConnect(candidate, 6000);
    if (result) {
      return { ...result, adapted: result.uri !== uri };
    }
  }

  throw lastError || new Error("连接失败");
}

function splitTopLevelArgs(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }

  const args = [];
  let start = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depthParen += 1;
      continue;
    }
    if (char === ")") {
      depthParen -= 1;
      continue;
    }
    if (char === "[") {
      depthBracket += 1;
      continue;
    }
    if (char === "]") {
      depthBracket -= 1;
      continue;
    }
    if (char === "{") {
      depthBrace += 1;
      continue;
    }
    if (char === "}") {
      depthBrace -= 1;
      continue;
    }

    if (char === "," && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }

  if (quote || depthParen !== 0 || depthBracket !== 0 || depthBrace !== 0) {
    throw new Error("命令参数格式不完整");
  }

  args.push(text.slice(start).trim());
  return args.filter((item) => item !== "");
}

function findMatchingParen(text, openIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function parseCollectionLiteral(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error("getCollection 参数不能为空");
  }

  if (text.startsWith('"') && text.endsWith('"')) {
    const parsed = parseEjsonInput(text);
    if (typeof parsed !== "string") {
      throw new Error("getCollection 参数必须是字符串");
    }
    return parsed.trim();
  }

  if (text.startsWith("'") && text.endsWith("'")) {
    return text
      .slice(1, -1)
      .replaceAll("\\'", "'")
      .replaceAll("\\\\", "\\")
      .trim();
  }

  if (text.startsWith("`") && text.endsWith("`")) {
    return text
      .slice(1, -1)
      .replaceAll("\\`", "`")
      .replaceAll("\\\\", "\\")
      .trim();
  }

  const parsed = parseEjsonInput(text);
  if (typeof parsed !== "string") {
    throw new Error("getCollection 参数必须是字符串");
  }
  return parsed.trim();
}

function parseTerminalCommand(command, fallbackCollectionName = "") {
  const source = String(command || "").trim().replace(/;+\s*$/, "");
  if (!source) {
    throw new Error("命令不能为空");
  }
  if (!source.startsWith("db.")) {
    throw new Error("命令必须以 db. 开头");
  }

  let collectionName = fallbackCollectionName || "";
  let operationSegment = "";

  if (source.startsWith("db.getCollection(")) {
    const openIndex = source.indexOf("(");
    const closeIndex = findMatchingParen(source, openIndex);
    if (closeIndex < 0) {
      throw new Error("getCollection 调用格式错误");
    }

    const argRaw = source.slice(openIndex + 1, closeIndex);
    collectionName = parseCollectionLiteral(argRaw);

    const tail = source.slice(closeIndex + 1).trim();
    if (!tail.startsWith(".")) {
      throw new Error("缺少操作方法，如 .find({})");
    }
    operationSegment = tail.slice(1).trim();
  } else {
    const collectionMatch = source.match(/^db\.([A-Za-z0-9_$.-]+)\.(.+)$/);
    if (!collectionMatch) {
      throw new Error("命令格式错误，示例: db.users.find({})");
    }
    collectionName = collectionMatch[1];
    operationSegment = collectionMatch[2].trim();
  }

  if (!collectionName) {
    throw new Error("请先选择集合，或在命令中指定集合");
  }

  const opMatch = operationSegment.match(/^([A-Za-z][A-Za-z0-9]*)\(([\s\S]*)\)$/);
  if (!opMatch) {
    throw new Error("命令格式错误，请使用 method(...) 形式");
  }

  const operation = opMatch[1];
  const args = splitTopLevelArgs(opMatch[2]);
  return { collectionName, operation, args, source };
}

function assertPlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} 必须是对象`);
  }
  return value;
}

function parseLimit(value, fallback = 50, max = 500) {
  const raw = Number(value);
  if (!Number.isInteger(raw)) {
    return fallback;
  }
  return Math.min(Math.max(raw, 1), max);
}

async function runTerminalCommand(commandText) {
  assertDbSelected();
  const parsed = parseTerminalCommand(commandText, state.collectionName);
  state.collectionName = parsed.collectionName;

  const collection = getCollection();
  const startedAt = Date.now();
  const op = parsed.operation;
  const args = parsed.args;

  if (op === "find") {
    const filter = assertPlainObject(parseEjsonInput(args[0], {}), "filter");
    const projection = parseEjsonInput(args[1], undefined);
    const options = parseEjsonInput(args[2], {});
    if (projection !== undefined) {
      assertPlainObject(projection, "projection");
    }
    if (options !== undefined) {
      assertPlainObject(options, "options");
    }

    const cursor = collection.find(filter);
    if (projection) {
      cursor.project(projection);
    }
    if (options?.projection) {
      cursor.project(assertPlainObject(options.projection, "options.projection"));
    }
    if (options?.sort) {
      cursor.sort(assertPlainObject(options.sort, "options.sort"));
    }
    const limit = parseLimit(options?.limit, 50, 500);
    const docs = await cursor.limit(limit).toArray();
    return {
      resultType: "find",
      count: docs.length,
      limit,
      docs: toTransport(docs),
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (op === "findOne") {
    const filter = assertPlainObject(parseEjsonInput(args[0], {}), "filter");
    const projection = parseEjsonInput(args[1], undefined);
    if (projection !== undefined) {
      assertPlainObject(projection, "projection");
    }
    const doc = await collection.findOne(filter, projection ? { projection } : undefined);
    return {
      resultType: "findOne",
      doc: doc ? toTransport(doc) : null,
      found: Boolean(doc),
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (op === "countDocuments") {
    const filter = assertPlainObject(parseEjsonInput(args[0], {}), "filter");
    const count = await collection.countDocuments(filter);
    return {
      resultType: "countDocuments",
      count,
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (op === "insertOne") {
    const doc = parseEjsonInput(args[0]);
    assertPlainObject(doc, "doc");
    const result = await collection.insertOne(doc);
    return {
      resultType: "insertOne",
      insertedId: toTransport(result.insertedId),
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (op === "insertMany") {
    const docs = parseEjsonInput(args[0]);
    if (!Array.isArray(docs) || !docs.length) {
      throw new Error("insertMany 参数必须是非空数组");
    }
    docs.forEach((doc) => assertPlainObject(doc, "insertMany 文档"));
    const result = await collection.insertMany(docs);
    return {
      resultType: "insertMany",
      insertedCount: result.insertedCount,
      insertedIds: toTransport(result.insertedIds),
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (op === "updateOne" || op === "updateMany") {
    const filter = assertPlainObject(parseEjsonInput(args[0], {}), "filter");
    const update = parseEjsonInput(args[1]);
    if (
      !update ||
      typeof update !== "object" ||
      (!Array.isArray(update) && Object.keys(update).length === 0)
    ) {
      throw new Error("update 必须是对象或聚合管道数组");
    }
    const options = parseEjsonInput(args[2], {});
    if (options !== undefined) {
      assertPlainObject(options, "options");
    }

    const result =
      op === "updateMany"
        ? await collection.updateMany(filter, update, { upsert: Boolean(options?.upsert) })
        : await collection.updateOne(filter, update, { upsert: Boolean(options?.upsert) });

    return {
      resultType: op,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedCount: result.upsertedCount,
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (op === "deleteOne" || op === "deleteMany") {
    const filter = assertPlainObject(parseEjsonInput(args[0], {}), "filter");
    const result =
      op === "deleteMany"
        ? await collection.deleteMany(filter)
        : await collection.deleteOne(filter);
    return {
      resultType: op,
      deletedCount: result.deletedCount,
      elapsedMs: Date.now() - startedAt,
    };
  }

  throw new Error(
    "仅支持 find/findOne/countDocuments/insertOne/insertMany/updateOne/updateMany/deleteOne/deleteMany",
  );
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
    const connected = await connectWithAdaptiveRetry(uri);

    state.client = connected.client;
    state.uri = connected.uri;
    state.dbName = connected.client.db().databaseName || "";
    state.collectionName = "";

    res.json({
      ok: true,
      status: getStatus(),
      adapted: connected.adapted,
      adaptationReason: connected.adapted ? connected.reason : null,
    });
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
  "/api/command",
  asyncHandler(async (req, res) => {
    const command = String(req.body?.command || "").trim();
    if (!command) {
      return res.status(400).json({ ok: false, error: "命令不能为空" });
    }

    const result = await runTerminalCommand(command);
    res.json({
      ok: true,
      status: getStatus(),
      command,
      ...result,
    });
  }),
);

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
