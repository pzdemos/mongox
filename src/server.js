#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import yaml from "js-yaml";
import JSON5 from "json5";
import { EJSON } from "bson";
import { MongoClient } from "mongodb";
import { PostgresDriver } from "./drivers/postgres.js";
import { MysqlDriver } from "./drivers/mysql.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_PREFIX = "/mongo/api";
const apiPath = (pathName) => `${API_PREFIX}${pathName}`;
const COOKIE_NAME = "mongox_client_id";
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 365;
const AUTH_COOKIE_NAME = "mongox_auth";
const AUTH_MAX_AGE = 1000 * 60 * 60 * 24 * 7;
const AUTH_PASSWORD = process.env.MONGOX_PASSWORD || "";
const PUBLIC_PATHS = new Set(["/login", "/login.html"]);
const PUBLIC_API_PREFIXES = [`${API_PREFIX}/login`, `${API_PREFIX}/health`];
const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_FILE = path.join(DATA_DIR, "connections.json");

let persistentStore = { clients: {} };
let persistQueue = Promise.resolve();
const runtimeStore = new Map();
const reconnectLocks = new Map();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(requireAuth);
app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});
app.use(express.static(path.join(__dirname, "..", "public")));

const asyncHandler =
  (fn) =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

function nowIso() {
  return new Date().toISOString();
}

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

  const text = input.trim();
  try {
    return EJSON.parse(text);
  } catch (error) {
    try {
      const looseParsed = JSON5.parse(text);
      return EJSON.deserialize(looseParsed);
    } catch {
      throw error;
    }
  }
}

function parseCookies(rawCookieHeader = "") {
  return rawCookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const index = pair.indexOf("=");
      if (index < 0) {
        return acc;
      }
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!key) {
        return acc;
      }
      try {
        acc[key] = decodeURIComponent(value);
      } catch {
        acc[key] = value;
      }
      return acc;
    }, {});
}

function serializeCookie(name, value, maxAge) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.floor(maxAge / 1000)}`,
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

function signAuth(payload) {
  const hmac = crypto.createHmac("sha256", AUTH_PASSWORD).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

function verifyAuth(cookieValue) {
  if (typeof cookieValue !== "string" || !cookieValue.includes(".")) return false;
  const sepIdx = cookieValue.lastIndexOf(".");
  const payload = cookieValue.slice(0, sepIdx);
  const sig = cookieValue.slice(sepIdx + 1);
  const expected = crypto.createHmac("sha256", AUTH_PASSWORD).update(payload).digest("hex");
  if (sig.length !== expected.length) return false;
  let a = Buffer.from(sig, "hex");
  let b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  const expireAt = Number.parseInt(payload, 10);
  if (!Number.isFinite(expireAt) || expireAt < Date.now()) return false;
  return true;
}

function isPublicPath(reqPath) {
  if (PUBLIC_PATHS.has(reqPath)) return true;
  return PUBLIC_API_PREFIXES.some((p) => reqPath === p || reqPath.startsWith(`${p}/`));
}

function requireAuth(req, res, next) {
  if (isPublicPath(req.path)) return next();
  const cookies = parseCookies(req.headers.cookie || "");
  if (verifyAuth(cookies[AUTH_COOKIE_NAME])) return next();
  if (req.path.startsWith(API_PREFIX)) {
    return res.status(401).json({ ok: false, error: "未登录或会话已过期" });
  }
  return res.redirect("/login");
}

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie || "");
  let clientId = cookies[COOKIE_NAME];
  if (!clientId) {
    clientId = crypto.randomUUID();
    res.setHeader("Set-Cookie", serializeCookie(COOKIE_NAME, clientId, COOKIE_MAX_AGE));
  }
  req.clientId = clientId;
  next();
});

function normalizeConnectionRecord(record = {}) {
  const typeRaw = String(record.type || "mongo").trim().toLowerCase();
  const type = ["mongo", "postgres", "mysql"].includes(typeRaw) ? typeRaw : "mongo";
  return {
    id: String(record.id || crypto.randomUUID()),
    name: String(record.name || "").trim(),
    type,
    uri: String(record.uri || "").trim(),
    dbName: String(record.dbName || "").trim(),
    collectionName: String(record.collectionName || "").trim(),
    createdAt: String(record.createdAt || nowIso()),
    updatedAt: String(record.updatedAt || nowIso()),
    lastUsedAt: record.lastUsedAt ? String(record.lastUsedAt) : null,
    lastConnectedAt: record.lastConnectedAt ? String(record.lastConnectedAt) : null,
  };
}

function normalizeBucket(rawBucket = {}) {
  return {
    activeConnectionId: rawBucket.activeConnectionId ? String(rawBucket.activeConnectionId) : null,
    connections: Array.isArray(rawBucket.connections)
      ? rawBucket.connections.map((item) => normalizeConnectionRecord(item))
      : [],
  };
}

async function persistStore() {
  const content = JSON.stringify(persistentStore, null, 2);
  persistQueue = persistQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmpFile = `${STORE_FILE}.tmp`;
    await fs.writeFile(tmpFile, content, "utf8");
    await fs.rename(tmpFile, STORE_FILE);
  });
  return persistQueue;
}

async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const clients = {};
    Object.entries(parsed?.clients || {}).forEach(([clientId, bucket]) => {
      clients[clientId] = normalizeBucket(bucket);
    });
    persistentStore = { clients };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    persistentStore = { clients: {} };
    await persistStore();
  }
}

function getClientBucket(clientId) {
  if (!persistentStore.clients[clientId]) {
    persistentStore.clients[clientId] = normalizeBucket();
  }
  return persistentStore.clients[clientId];
}

function listConnections(bucket) {
  return [...bucket.connections].sort((left, right) => {
    const leftScore = left.lastUsedAt || left.updatedAt || left.createdAt;
    const rightScore = right.lastUsedAt || right.updatedAt || right.createdAt;
    return String(rightScore).localeCompare(String(leftScore));
  });
}

function inferConnectionName(uri, type = "mongo", fallback = "未命名连接") {
  if (!uri) {
    return fallback;
  }
  try {
    const parsed = new URL(uri);
    const host = parsed.host || parsed.hostname;
    if (!host) return fallback;
    const label = type === "postgres" ? "PG" : type === "mysql" ? "MySQL" : "Mongo";
    return `${label} @ ${host}`;
  } catch {
    return fallback;
  }
}

function findConnection(bucket, connectionId) {
  return bucket.connections.find((item) => item.id === connectionId) || null;
}

function findConnectionByUri(bucket, uri, excludeId = null) {
  const normalized = String(uri || "").trim();
  if (!normalized) {
    return null;
  }
  return (
    bucket.connections.find(
      (item) => item.uri === normalized && (!excludeId || item.id !== excludeId),
    ) || null
  );
}

function removeConnection(bucket, connectionId) {
  bucket.connections = bucket.connections.filter((item) => item.id !== connectionId);
  if (bucket.activeConnectionId === connectionId) {
    bucket.activeConnectionId = bucket.connections[0]?.id || null;
  }
}

function runtimeBucket(clientId) {
  if (!runtimeStore.has(clientId)) {
    runtimeStore.set(clientId, new Map());
  }
  return runtimeStore.get(clientId);
}

function runtimeKey(clientId, connectionId) {
  return `${clientId}:${connectionId}`;
}

function getRuntime(clientId, connectionId) {
  return runtimeStore.get(clientId)?.get(connectionId) || null;
}

function setRuntime(clientId, connectionId, runtime) {
  runtimeBucket(clientId).set(connectionId, runtime);
}

async function closeMongoClient(client) {
  if (!client) {
    return;
  }
  await client.close().catch(() => {});
}

async function disconnectRuntime(clientId, connectionId) {
  const bucket = runtimeStore.get(clientId);
  const runtime = bucket?.get(connectionId) || null;
  if (bucket) {
    bucket.delete(connectionId);
    if (bucket.size === 0) {
      runtimeStore.delete(clientId);
    }
  }
  if (runtime?.driver) {
    await runtime.driver.disconnect().catch(() => {});
    return;
  }
  await closeMongoClient(runtime?.client);
}

async function disconnectAllRuntimes() {
  const jobs = [];
  runtimeStore.forEach((bucket, clientId) => {
    bucket.forEach((_runtime, connectionId) => {
      jobs.push(disconnectRuntime(clientId, connectionId));
    });
  });
  await Promise.allSettled(jobs);
}

function maskMongoUri(uri) {
  if (!uri || typeof uri !== "string") {
    return uri;
  }
  try {
    const url = new URL(uri);
    if (url.password) {
      url.password = "****";
    }
    return url.toString();
  } catch {
    return uri.replace(/(mongodb(\+srv)?:\/\/[^:@]+:)[^@]+(@)/, "$1****$3");
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
  const tried = [];
  let lastError = null;

  const tryConnect = async ({ uri: candidateUri, reason }, timeoutMS) => {
    if (!candidateUri || tried.some((t) => t.uri === candidateUri)) {
      return null;
    }
    tried.push({ uri: candidateUri, reason });

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
    6000,
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
    const result = await tryConnect(candidate, 2000);
    if (result) {
      return { ...result, adapted: result.uri !== uri };
    }
  }

  const err = lastError || new Error("连接失败");
  err.triedVariants = tried;
  err.statusCode = 502;
  throw err;
}

async function pingRuntime(runtime) {
  if (!runtime) return false;
  if (runtime.driver) {
    const now = Date.now();
    if (runtime.lastPingAt && now - runtime.lastPingAt < 10000) return true;
    try {
      if (runtime.driver.type === "postgres") {
        await runtime.driver.pool.query("SELECT 1");
      } else if (runtime.driver.type === "mysql") {
        await runtime.driver.pool.query("SELECT 1");
      } else {
        return false;
      }
      runtime.lastPingAt = now;
      return true;
    } catch {
      return false;
    }
  }
  if (!runtime.client) return false;

  const now = Date.now();
  if (runtime.lastPingAt && now - runtime.lastPingAt < 10000) {
    return true;
  }

  try {
    await runtime.client.db("admin").command({ ping: 1 });
    runtime.lastPingAt = now;
    return true;
  } catch {
    return false;
  }
}

async function ensureRuntimeConnected(clientId, connection, { persist = true } = {}) {
  const current = getRuntime(clientId, connection.id);
  if (await pingRuntime(current)) {
    connection.lastUsedAt = nowIso();
    if (persist) {
      await persistStore();
    }
    return { runtime: current, adapted: false, reason: null };
  }

  const lockKey = runtimeKey(clientId, connection.id);
  if (reconnectLocks.has(lockKey)) {
    return reconnectLocks.get(lockKey);
  }

  const task = (async () => {
    await disconnectRuntime(clientId, connection.id);

    if (connection.type === "postgres" || connection.type === "mysql") {
      const Driver = connection.type === "postgres" ? PostgresDriver : MysqlDriver;
      const driver = new Driver(connection.uri);
      await driver.connect();
      const runtime = { driver, lastPingAt: Date.now() };
      setRuntime(clientId, connection.id, runtime);
      if (!connection.dbName) connection.dbName = driver.dbName || "";
      connection.lastConnectedAt = nowIso();
      connection.lastUsedAt = connection.lastConnectedAt;
      if (persist) {
        await persistStore();
      }
      return { runtime, adapted: false, reason: null };
    }

    const connected = await connectWithAdaptiveRetry(connection.uri);
    const runtime = { client: connected.client, lastPingAt: Date.now() };
    setRuntime(clientId, connection.id, runtime);

    if (connected.uri && connected.uri !== connection.uri) {
      connection.uri = connected.uri;
      connection.updatedAt = nowIso();
    }

    if (!connection.dbName) {
      connection.dbName = connected.client.db().databaseName || "";
    }

    connection.lastConnectedAt = nowIso();
    connection.lastUsedAt = connection.lastConnectedAt;
    if (persist) {
      await persistStore();
    }

    return {
      runtime,
      adapted: connected.adapted,
      reason: connected.adapted ? connected.reason : null,
    };
  })();

  reconnectLocks.set(lockKey, task);
  try {
    return await task;
  } finally {
    reconnectLocks.delete(lockKey);
  }
}

function buildConnectionSummary(clientId, connection, bucket) {
  const runtime = getRuntime(clientId, connection.id);
  return {
    id: connection.id,
    name: connection.name,
    type: connection.type,
    uri: connection.uri,
    uriMasked: maskMongoUri(connection.uri),
    dbName: connection.dbName || "",
    collectionName: connection.collectionName || "",
    connected: Boolean(runtime?.client || runtime?.driver),
    isActive: bucket.activeConnectionId === connection.id,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastUsedAt: connection.lastUsedAt,
    lastConnectedAt: connection.lastConnectedAt,
  };
}

function buildStatus(clientId, bucket) {
  const empty = {
    connected: false,
    driverType: "mongo",
    activeConnectionId: bucket.activeConnectionId || null,
    connectionName: "",
    uri: "",
    uriMasked: "",
    dbName: "",
    collectionName: "",
  };

  if (!bucket.activeConnectionId) {
    return empty;
  }

  const active = findConnection(bucket, bucket.activeConnectionId);
  if (!active) {
    return empty;
  }

  const runtime = getRuntime(clientId, active.id);
  return {
    connected: Boolean(runtime?.client || runtime?.driver),
    driverType: active.type || "mongo",
    activeConnectionId: active.id,
    connectionName: active.name,
    uri: active.uri,
    uriMasked: maskMongoUri(active.uri),
    dbName: active.dbName || "",
    collectionName: active.collectionName || "",
  };
}

function requireActiveConnection(req) {
  const bucket = getClientBucket(req.clientId);
  if (!bucket.activeConnectionId) {
    const error = new Error("请先选择连接配置");
    error.statusCode = 400;
    throw error;
  }

  const connection = findConnection(bucket, bucket.activeConnectionId);
  if (!connection) {
    bucket.activeConnectionId = null;
    const error = new Error("当前连接配置不存在，请重新选择");
    error.statusCode = 400;
    throw error;
  }

  return { bucket, connection };
}

async function requireReadyContext(req, options = {}) {
  const { bucket, connection } = requireActiveConnection(req);
  const { runtime } = await ensureRuntimeConnected(req.clientId, connection);

  if (options.requireDb && !connection.dbName) {
    const error = new Error("请先选择数据库");
    error.statusCode = 400;
    throw error;
  }

  if (options.requireCollection && !connection.collectionName) {
    const error = new Error("请先选择集合");
    error.statusCode = 400;
    throw error;
  }

  return { bucket, connection, runtime };
}

function getCollection(runtime, connection) {
  return runtime.client.db(connection.dbName).collection(connection.collectionName);
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

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
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
      args.push(text.slice(start, index).trim());
      start = index + 1;
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

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
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
        return index;
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

function parseMethodChain(operationSegment) {
  const segment = String(operationSegment || "").trim();
  if (!segment) {
    throw new Error("命令格式错误，请使用 method(...) 形式");
  }

  const methods = [];
  let index = 0;
  const consumeSpaces = () => {
    while (index < segment.length && /\s/.test(segment[index])) {
      index += 1;
    }
  };

  while (index < segment.length) {
    consumeSpaces();
    const nameMatch = segment.slice(index).match(/^([A-Za-z][A-Za-z0-9]*)/);
    if (!nameMatch) {
      throw new Error("命令格式错误，请使用 method(...) 形式");
    }

    const name = nameMatch[1];
    index += name.length;
    consumeSpaces();

    if (segment[index] !== "(") {
      throw new Error(`方法 ${name} 缺少参数括号`);
    }

    const openIndex = index;
    const closeIndex = findMatchingParen(segment, openIndex);
    if (closeIndex < 0) {
      throw new Error(`方法 ${name} 参数括号未闭合`);
    }

    const argsRaw = segment.slice(openIndex + 1, closeIndex);
    methods.push({ name, args: splitTopLevelArgs(argsRaw) });
    index = closeIndex + 1;
    consumeSpaces();

    if (index >= segment.length) {
      break;
    }

    if (segment[index] !== ".") {
      throw new Error("命令格式错误，请使用 method(...).next(...) 形式");
    }
    index += 1;
  }

  return methods;
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

  const methods = parseMethodChain(operationSegment);
  const [firstCall, ...chain] = methods;
  return {
    collectionName,
    operation: firstCall.name,
    args: firstCall.args,
    chain,
    source,
  };
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

function parseSkip(value, fallback = 0, max = 100000) {
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < 0) {
    return fallback;
  }
  return Math.min(raw, max);
}

async function runTerminalCommand(commandText, runtime, connection) {
  if (!connection.dbName) {
    const error = new Error("请先选择数据库");
    error.statusCode = 400;
    throw error;
  }

  const parsed = parseTerminalCommand(commandText, connection.collectionName);
  connection.collectionName = parsed.collectionName;

  const collection = runtime.client.db(connection.dbName).collection(connection.collectionName);
  const startedAt = Date.now();
  const op = parsed.operation;
  const args = parsed.args;
  const chain = parsed.chain || [];

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
    let limit = parseLimit(options?.limit, 50, 500);
    let skip = parseSkip(options?.skip, 0, 100000);

    for (const call of chain) {
      const method = call.name;
      const callArgs = call.args || [];

      if (method === "sort") {
        cursor.sort(assertPlainObject(parseEjsonInput(callArgs[0], {}), "sort"));
        continue;
      }

      if (method === "project") {
        cursor.project(assertPlainObject(parseEjsonInput(callArgs[0], {}), "projection"));
        continue;
      }

      if (method === "limit") {
        limit = parseLimit(parseEjsonInput(callArgs[0], limit), limit, 500);
        continue;
      }

      if (method === "skip") {
        skip = parseSkip(parseEjsonInput(callArgs[0], skip), skip, 100000);
        continue;
      }

      if (method === "toArray") {
        continue;
      }

      throw new Error("find 链式调用仅支持 sort/project/limit/skip/toArray");
    }

    if (skip > 0) {
      cursor.skip(skip);
    }

    const docs = await cursor.limit(limit).toArray();
    return {
      resultType: "find",
      count: docs.length,
      limit,
      skip,
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

  const lines = docs.map((doc) => keys.map((key) => esc(doc[key])).join(","));
  return `${keys.join(",")}\n${lines.join("\n")}\n`;
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

async function connectSavedConnection(clientId, bucket, connection) {
  bucket.activeConnectionId = connection.id;
  return ensureRuntimeConnected(clientId, connection);
}

app.get(apiPath("/health"), (req, res) => {
  const bucket = getClientBucket(req.clientId);
  res.json({ ok: true, status: buildStatus(req.clientId, bucket) });
});

app.post(apiPath("/login"), (req, res) => {
  const { password } = req.body || {};
  if (!AUTH_PASSWORD) {
    return res.status(500).json({ ok: false, error: "服务端未配置密码" });
  }
  if (typeof password !== "string" || password.length === 0) {
    return res.status(400).json({ ok: false, error: "请输入密码" });
  }
  const a = Buffer.from(password);
  const b = Buffer.from(AUTH_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: "密码错误" });
  }
  const expireAt = Date.now() + AUTH_MAX_AGE;
  const cookieValue = signAuth(`${expireAt}`);
  res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE_NAME, cookieValue, AUTH_MAX_AGE));
  res.json({ ok: true });
});

app.post(apiPath("/logout"), (req, res) => {
  res.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE_NAME, "", 0));
  res.json({ ok: true });
});

app.get(apiPath("/status"), (req, res) => {
  const bucket = getClientBucket(req.clientId);
  res.json({ ok: true, status: buildStatus(req.clientId, bucket) });
});

app.get(apiPath("/connections"), (req, res) => {
  const bucket = getClientBucket(req.clientId);
  res.json({
    ok: true,
    activeConnectionId: bucket.activeConnectionId,
    status: buildStatus(req.clientId, bucket),
    connections: listConnections(bucket).map((item) =>
      buildConnectionSummary(req.clientId, item, bucket),
    ),
  });
});

app.post(
  apiPath("/connections"),
  asyncHandler(async (req, res) => {
    const bucket = getClientBucket(req.clientId);
    const uri = String(req.body?.uri || "").trim();
    if (!uri) {
      return res.status(400).json({ ok: false, error: "连接字符串不能为空" });
    }

    const id = req.body?.id ? String(req.body.id) : null;
    const existing = id
      ? findConnection(bucket, id)
      : findConnectionByUri(bucket, uri);
    const name =
      String(req.body?.name || "").trim() || existing?.name || inferConnectionName(uri);

    const now = nowIso();
    if (existing) {
      existing.name = name;
      existing.uri = uri;
      existing.updatedAt = now;
    } else {
      const next = normalizeConnectionRecord({
        id: crypto.randomUUID(),
        name,
        uri,
        createdAt: now,
        updatedAt: now,
      });
      bucket.connections.push(next);
      bucket.activeConnectionId = next.id;
    }

    if (existing) {
      bucket.activeConnectionId = existing.id;
    }

    await persistStore();
    const active = findConnection(bucket, bucket.activeConnectionId);
    res.json({
      ok: true,
      status: buildStatus(req.clientId, bucket),
      connection: active ? buildConnectionSummary(req.clientId, active, bucket) : null,
      activeConnectionId: bucket.activeConnectionId,
    });
  }),
);

app.post(
  apiPath("/connections/:id/select"),
  asyncHandler(async (req, res) => {
    const bucket = getClientBucket(req.clientId);
    const connection = findConnection(bucket, req.params.id);
    if (!connection) {
      return res.status(404).json({ ok: false, error: "连接配置不存在" });
    }

    bucket.activeConnectionId = connection.id;
    connection.lastUsedAt = nowIso();
    await persistStore();

    res.json({
      ok: true,
      status: buildStatus(req.clientId, bucket),
      connection: buildConnectionSummary(req.clientId, connection, bucket),
    });
  }),
);

app.post(
  apiPath("/connections/:id/connect"),
  asyncHandler(async (req, res) => {
    const bucket = getClientBucket(req.clientId);
    const connection = findConnection(bucket, req.params.id);
    if (!connection) {
      return res.status(404).json({ ok: false, error: "连接配置不存在" });
    }

    const connected = await connectSavedConnection(req.clientId, bucket, connection);
    await persistStore();

    res.json({
      ok: true,
      status: buildStatus(req.clientId, bucket),
      connection: buildConnectionSummary(req.clientId, connection, bucket),
      adapted: connected.adapted,
      adaptationReason: connected.reason,
    });
  }),
);

app.post(
  apiPath("/connections/:id/disconnect"),
  asyncHandler(async (req, res) => {
    const bucket = getClientBucket(req.clientId);
    const connection = findConnection(bucket, req.params.id);
    if (!connection) {
      return res.status(404).json({ ok: false, error: "连接配置不存在" });
    }

    await disconnectRuntime(req.clientId, connection.id);
    connection.lastUsedAt = nowIso();
    await persistStore();

    res.json({
      ok: true,
      status: buildStatus(req.clientId, bucket),
      connection: buildConnectionSummary(req.clientId, connection, bucket),
    });
  }),
);

app.delete(
  apiPath("/connections/:id"),
  asyncHandler(async (req, res) => {
    const bucket = getClientBucket(req.clientId);
    const connection = findConnection(bucket, req.params.id);
    if (!connection) {
      return res.status(404).json({ ok: false, error: "连接配置不存在" });
    }

    await disconnectRuntime(req.clientId, connection.id);
    removeConnection(bucket, connection.id);
    await persistStore();

    res.json({
      ok: true,
      status: buildStatus(req.clientId, bucket),
      activeConnectionId: bucket.activeConnectionId,
      connections: listConnections(bucket).map((item) =>
        buildConnectionSummary(req.clientId, item, bucket),
      ),
    });
  }),
);

app.post(
  apiPath("/connect"),
  asyncHandler(async (req, res) => {
    const bucket = getClientBucket(req.clientId);
    const uri = String(req.body?.uri || "").trim();
    if (!uri) {
      return res.status(400).json({ ok: false, error: "连接字符串不能为空" });
    }

    const typeRaw = String(req.body?.type || "mongo").trim().toLowerCase();
    const type = ["mongo", "postgres", "mysql"].includes(typeRaw) ? typeRaw : "mongo";

    const name = String(req.body?.name || "").trim() || inferConnectionName(uri, type);
    let connection = bucket.activeConnectionId
      ? findConnection(bucket, bucket.activeConnectionId)
      : null;

    if (!connection) {
      connection = findConnectionByUri(bucket, uri);
    }

    if (!connection) {
      connection = normalizeConnectionRecord({
        id: crypto.randomUUID(),
        name,
        uri,
        type,
      });
      bucket.connections.push(connection);
      bucket.activeConnectionId = connection.id;
    } else {
      connection.name = name || connection.name;
      connection.uri = uri;
      connection.type = type;
      connection.updatedAt = nowIso();
    }

    const connected = await connectSavedConnection(req.clientId, bucket, connection);
    await persistStore();

    res.json({
      ok: true,
      status: buildStatus(req.clientId, bucket),
      adapted: connected.adapted,
      adaptationReason: connected.reason,
      activeConnectionId: bucket.activeConnectionId,
    });
  }),
);

app.post(
  apiPath("/disconnect"),
  asyncHandler(async (req, res) => {
    const bucket = getClientBucket(req.clientId);
    if (bucket.activeConnectionId) {
      await disconnectRuntime(req.clientId, bucket.activeConnectionId);
    }
    res.json({ ok: true, status: buildStatus(req.clientId, bucket) });
  }),
);

app.get(
  apiPath("/databases"),
  asyncHandler(async (req, res) => {
    const { connection, runtime } = await requireReadyContext(req);
    if (runtime.driver) {
      try {
        const list = await runtime.driver.listDatabases();
        const databases = list
          .map((d) => ({ name: d.name, sizeOnDisk: null }))
          .sort((l, r) => l.name.localeCompare(r.name));
        if (!connection.dbName && databases.length) {
          connection.dbName = databases[0].name;
          connection.updatedAt = nowIso();
          await persistStore();
        }
        return res.json({ ok: true, databases, warning: null });
      } catch (error) {
        return res.json({
          ok: true,
          databases: [],
          warning: `无法列出数据库。原因: ${error.message}`,
        });
      }
    }
    try {
      const list = await runtime.client.db("admin").admin().listDatabases({ nameOnly: true });
      const databases = list.databases
        .map((db) => ({ name: db.name, sizeOnDisk: db.sizeOnDisk }))
        .sort((left, right) => left.name.localeCompare(right.name));

      if (!connection.dbName && databases.length) {
        connection.dbName = databases[0].name;
        connection.updatedAt = nowIso();
        await persistStore();
      }

      return res.json({ ok: true, databases, warning: null });
    } catch (error) {
      const fallbackDb = runtime.client.db().databaseName || "test";
      return res.json({
        ok: true,
        databases: [{ name: fallbackDb, sizeOnDisk: null }],
        warning: `无法列出数据库，请手动输入数据库名。原因: ${error.message}`,
      });
    }
  }),
);

app.post(
  apiPath("/database"),
  asyncHandler(async (req, res) => {
    const { bucket, connection, runtime } = await requireReadyContext(req);
    const dbName = String(req.body?.dbName || "").trim();
    if (!dbName) {
      return res.status(400).json({ ok: false, error: "数据库名不能为空" });
    }

    connection.dbName = dbName;
    connection.collectionName = "";
    connection.updatedAt = nowIso();

    let collections = [];
    let warning = null;
    try {
      if (runtime.driver) {
        const tables = await runtime.driver.listTables(dbName);
        collections = tables.map((t) => t.name).sort((l, r) => l.localeCompare(r));
      } else {
        const result = await runtime.client.db(connection.dbName).listCollections().toArray();
        collections = result.map((item) => item.name).sort((left, right) => left.localeCompare(right));
      }
    } catch (error) {
      warning = `无法列出${runtime.driver ? "表" : "集合"}，请手动输入。原因: ${error.message}`;
    }

    await persistStore();

    res.json({
      ok: true,
      status: buildStatus(req.clientId, bucket),
      collections,
      warning,
    });
  }),
);

app.get(
  apiPath("/collections"),
  asyncHandler(async (req, res) => {
    const { connection, runtime } = await requireReadyContext(req, { requireDb: true });
    let collections = [];
    let warning = null;

    try {
      if (runtime.driver) {
        const tables = await runtime.driver.listTables(connection.dbName);
        collections = tables.map((t) => t.name).sort((l, r) => l.localeCompare(r));
      } else {
        collections = await runtime.client.db(connection.dbName).listCollections().toArray();
        collections = collections.map((item) => item.name).sort((l, r) => l.localeCompare(r));
      }
    } catch (error) {
      warning = `无法列出${runtime.driver ? "表" : "集合"}，请手动输入。原因: ${error.message}`;
    }

    res.json({ ok: true, collections, warning });
  }),
);

app.get(
  apiPath("/search-collections"),
  asyncHandler(async (req, res) => {
    const { runtime } = await requireReadyContext(req, { requireDb: true });
    const keyword = String(req.query?.keyword || "").trim().toLowerCase();

    if (!keyword) {
      return res.json({ ok: true, matches: [], truncated: false });
    }

    if (runtime.driver) {
      try {
        const { matches, truncated } = await runtime.driver.searchTables(keyword);
        return res.json({ ok: true, matches, truncated });
      } catch (error) {
        return res.status(500).json({ ok: false, error: `搜索失败: ${error.message}` });
      }
    }

    const limitRaw = parseInt(req.query?.limit, 10);
    const limit = Number.isInteger(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 200)
      : 100;

    const SYSTEM_DBS = new Set(["admin", "local", "config"]);
    const matches = [];
    let truncated = false;

    try {
      const list = await runtime.client.db("admin").admin().listDatabases({ nameOnly: true });
      const dbNames = list.databases
        .map((d) => d.name)
        .filter((n) => !SYSTEM_DBS.has(n))
        .sort((left, right) => left.localeCompare(right));

      for (const dbName of dbNames) {
        if (truncated) break;
        try {
          const cols = await runtime.client.db(dbName).listCollections().toArray();
          for (const col of cols) {
            if (col.name && col.name.toLowerCase().includes(keyword)) {
              if (matches.length >= limit) {
                truncated = true;
                break;
              }
              matches.push({ database: dbName, collection: col.name });
            }
          }
        } catch {
          // 跳过无权限或异常的数据库
        }
      }

      matches.sort((a, b) => {
        const c = a.collection.localeCompare(b.collection);
        return c !== 0 ? c : a.database.localeCompare(b.database);
      });

      res.json({ ok: true, matches, truncated });
    } catch (error) {
      res.status(500).json({ ok: false, error: `搜索失败: ${error.message}` });
    }
  }),
);

app.post(
  apiPath("/collection"),
  asyncHandler(async (req, res) => {
    const { bucket, connection } = await requireReadyContext(req, { requireDb: true });
    const collectionName = String(req.body?.collectionName || "").trim();
    if (!collectionName) {
      return res.status(400).json({ ok: false, error: "集合名不能为空" });
    }

    connection.collectionName = collectionName;
    connection.updatedAt = nowIso();
    await persistStore();

    res.json({ ok: true, status: buildStatus(req.clientId, bucket) });
  }),
);

app.post(
  apiPath("/command"),
  asyncHandler(async (req, res) => {
    const { bucket, connection, runtime } = await requireReadyContext(req, { requireDb: true });
    const command = String(req.body?.command || "").trim();
    if (!command) {
      return res.status(400).json({ ok: false, error: "命令不能为空" });
    }

    if (runtime.driver) {
      const result = await runtime.driver.runCommand(command);
      connection.updatedAt = nowIso();
      connection.lastUsedAt = nowIso();
      await persistStore();
      return res.json({
        ok: true,
        status: buildStatus(req.clientId, bucket),
        command,
        ...result,
      });
    }

    const result = await runTerminalCommand(command, runtime, connection);
    connection.updatedAt = nowIso();
    connection.lastUsedAt = nowIso();
    await persistStore();

    res.json({
      ok: true,
      status: buildStatus(req.clientId, bucket),
      command,
      ...result,
    });
  }),
);

app.post(
  apiPath("/query"),
  asyncHandler(async (req, res) => {
    const { connection, runtime } = await requireReadyContext(req, {
      requireDb: true,
      requireCollection: true,
    });

    if (runtime.driver) {
      const result = await runtime.driver.query(connection.dbName, connection.collectionName, {
        where: String(req.body?.where || req.body?.filter || "").trim(),
        orderBy: String(req.body?.orderBy || req.body?.sort || "").trim(),
        limit: Number(req.body?.limit ?? 20),
      });
      return res.json({ ok: true, count: result.docs.length, docs: result.docs, sql: result.sql });
    }

    const filter = parseEjsonInput(req.body?.filter, {});
    const projection = parseEjsonInput(req.body?.projection, undefined);
    const sort = parseEjsonInput(req.body?.sort, undefined);
    const limitRaw = Number(req.body?.limit ?? 20);
    const limit = Number.isInteger(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 500)
      : 20;

    const cursor = getCollection(runtime, connection).find(filter);
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
  apiPath("/insert"),
  asyncHandler(async (req, res) => {
    const { runtime, connection } = await requireReadyContext(req, {
      requireDb: true,
      requireCollection: true,
    });

    if (runtime.driver) {
      const doc = req.body?.doc;
      const parsed = typeof doc === "string" ? safeJsonParse(doc) : doc;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        return res.status(400).json({ ok: false, error: "插入内容必须是 JSON 对象" });
      }
      const result = await runtime.driver.insert(connection.dbName, connection.collectionName, parsed);
      return res.json({ ok: true, inserted: result.inserted, returning: result.returning || [] });
    }

    const doc = parseEjsonInput(req.body?.doc);
    if (!doc || Array.isArray(doc) || typeof doc !== "object") {
      return res.status(400).json({ ok: false, error: "插入内容必须是对象类型文档" });
    }

    const result = await getCollection(runtime, connection).insertOne(doc);
    res.json({
      ok: true,
      insertedId: toTransport(result.insertedId),
    });
  }),
);

app.post(
  apiPath("/update"),
  asyncHandler(async (req, res) => {
    const { runtime, connection } = await requireReadyContext(req, {
      requireDb: true,
      requireCollection: true,
    });

    if (runtime.driver) {
      const where = String(req.body?.where || req.body?.filter || "").trim();
      let setDoc = req.body?.setDoc || req.body?.update;
      if (typeof setDoc === "string") setDoc = safeJsonParse(setDoc);
      if (!setDoc || typeof setDoc !== "object" || Array.isArray(setDoc)) {
        return res.status(400).json({ ok: false, error: "SET 内容必须是 JSON 对象" });
      }
      const result = await runtime.driver.update(connection.dbName, connection.collectionName, {
        where,
        setDoc,
      });
      return res.json({ ok: true, updated: result.updated });
    }

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

    const collection = getCollection(runtime, connection);
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
  apiPath("/delete"),
  asyncHandler(async (req, res) => {
    const { runtime, connection } = await requireReadyContext(req, {
      requireDb: true,
      requireCollection: true,
    });

    if (runtime.driver) {
      const where = String(req.body?.where || req.body?.filter || "").trim();
      const result = await runtime.driver.delete(connection.dbName, connection.collectionName, {
        where,
      });
      return res.json({ ok: true, deleted: result.deleted });
    }

    const filter = parseEjsonInput(req.body?.filter, {});
    const many = Boolean(req.body?.many);
    const collection = getCollection(runtime, connection);
    const result = many
      ? await collection.deleteMany(filter)
      : await collection.deleteOne(filter);
    res.json({ ok: true, deletedCount: result.deletedCount });
  }),
);

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e1) {
    try {
      return JSON5.parse(text);
    } catch {
      throw e1;
    }
  }
}

app.get(
  apiPath("/stats"),
  asyncHandler(async (req, res) => {
    const { runtime, connection } = await requireReadyContext(req, {
      requireDb: true,
      requireCollection: true,
    });
    const collection = getCollection(runtime, connection);
    const [estimatedCount, accurateCount, indexes] = await Promise.all([
      collection.estimatedDocumentCount(),
      collection.countDocuments(),
      collection.indexes(),
    ]);

    let collStats = null;
    try {
      collStats = await runtime.client
        .db(connection.dbName)
        .command({ collStats: connection.collectionName, scale: 1 });
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

app.get(
  apiPath("/indexes"),
  asyncHandler(async (req, res) => {
    const { runtime, connection } = await requireReadyContext(req, { requireDb: true });
    const dbName = String(req.query?.dbName || connection.dbName || "").trim();
    const collectionName = String(req.query?.collectionName || "").trim();
    if (!dbName) {
      return res.status(400).json({ ok: false, error: "请先选择数据库" });
    }
    if (!collectionName) {
      return res.status(400).json({ ok: false, error: "表名不能为空" });
    }

    if (runtime.driver) {
      const indexes = await runtime.driver.indexes(dbName, collectionName);
      return res.json({ ok: true, indexes });
    }

    const indexes = await runtime.client.db(dbName).collection(collectionName).indexes();
    res.json({
      ok: true,
      indexes: indexes.map((item) => ({
        name: item.name,
        key: item.key,
        unique: Boolean(item.unique),
        sparse: Boolean(item.sparse),
      })),
    });
  }),
);

app.get(
  apiPath("/collection-stats"),
  asyncHandler(async (req, res) => {
    const { runtime, connection } = await requireReadyContext(req, { requireDb: true });
    const dbName = String(req.query?.dbName || connection.dbName || "").trim();
    const collectionName = String(req.query?.collectionName || "").trim();
    if (!dbName) {
      return res.status(400).json({ ok: false, error: "请先选择数据库" });
    }
    if (!collectionName) {
      return res.status(400).json({ ok: false, error: "表名不能为空" });
    }

    if (runtime.driver) {
      const stats = await runtime.driver.stats(dbName, collectionName);
      return res.json({ ok: true, stats });
    }

    const collection = runtime.client.db(dbName).collection(collectionName);
    const [estimatedCount, accurateCount, collStats] = await Promise.all([
      collection.estimatedDocumentCount(),
      collection.countDocuments().catch(() => null),
      runtime.client
        .db(dbName)
        .command({ collStats: collectionName, scale: 1 })
        .catch(() => null),
    ]);

    if (!collStats) {
      return res.json({
        ok: true,
        stats: {
          estimatedCount,
          accurateCount,
          size: null,
          storageSize: null,
          nIndexes: null,
          avgObjSize: null,
          totalIndexSize: null,
          freeStorageSize: null,
          capped: null,
          indexSizes: {},
        },
      });
    }

    res.json({
      ok: true,
      stats: {
        estimatedCount,
        accurateCount,
        size: collStats.size ?? null,
        storageSize: collStats.storageSize ?? null,
        nIndexes: collStats.nIndexes ?? null,
        avgObjSize: collStats.avgObjSize ?? null,
        totalIndexSize: collStats.totalIndexSize ?? null,
        freeStorageSize: collStats.freeStorageSize ?? null,
        capped: collStats.capped ?? false,
        indexSizes: collStats.indexSizes || {},
      },
    });
  }),
);

app.post(
  apiPath("/export"),
  asyncHandler(async (req, res) => {
    const { runtime, connection } = await requireReadyContext(req, {
      requireDb: true,
      requireCollection: true,
    });
    const filter = parseEjsonInput(req.body?.filter, {});
    const projection = parseEjsonInput(req.body?.projection, undefined);
    const sort = parseEjsonInput(req.body?.sort, undefined);
    const format = String(req.body?.format || "json");
    const limitRaw = Number(req.body?.limit ?? 100);
    const limit = Number.isInteger(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 5000)
      : 100;

    const cursor = getCollection(runtime, connection).find(filter);
    if (projection) {
      cursor.project(projection);
    }
    if (sort) {
      cursor.sort(sort);
    }

    const docs = await cursor.limit(limit).toArray();

    let filename = `${connection.dbName}_${connection.collectionName}_${Date.now()}.${format}`;
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
      filename = `${connection.dbName}_${connection.collectionName}_${Date.now()}.txt`;
      content = EJSON.stringify(docs, { relaxed: false, indent: 2 });
    }

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(content);
  }),
);

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  const body = {
    ok: false,
    error: normalizeErrorMessage(error),
  };
  if (Array.isArray(error.triedVariants) && error.triedVariants.length > 1) {
    body.triedVariants = error.triedVariants;
  }
  res.status(statusCode).json(body);
});

let server = null;

async function gracefulShutdown() {
  await disconnectAllRuntimes();
  if (!server) {
    process.exit(0);
    return;
  }
  server.close(() => {
    process.exit(0);
  });
}

async function bootstrap() {
  if (!AUTH_PASSWORD) {
    console.error("FATAL: 未设置 MONGOX_PASSWORD 环境变量，拒绝启动");
    process.exit(1);
  }
  await loadStore();
  const port = Number(process.env.PORT || 5000);
  server = app.listen(port, '127.0.0.1', () => {
    console.log(`MongoDB Admin Web 已启动: http://localhost:${port}`);
  });
}

process.on("SIGINT", () => {
  void gracefulShutdown();
});
process.on("SIGTERM", () => {
  void gracefulShutdown();
});

bootstrap().catch(async (error) => {
  console.error(`启动失败: ${error.message}`);
  await gracefulShutdown();
});
