// 持久化存储层：connections.json 读写、client bucket 与连接记录管理
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DATA_DIR = path.join(__dirname, "..", "data");
export const STORE_FILE = path.join(DATA_DIR, "connections.json");

export let persistentStore = { clients: {} };
let persistQueue = Promise.resolve();

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeConnectionRecord(record = {}) {
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

export function normalizeBucket(rawBucket = {}) {
  return {
    activeConnectionId: rawBucket.activeConnectionId ? String(rawBucket.activeConnectionId) : null,
    lastActiveAt: String(rawBucket.lastActiveAt || nowIso()),
    connections: Array.isArray(rawBucket.connections)
      ? rawBucket.connections.map((item) => normalizeConnectionRecord(item))
      : [],
  };
}

export async function persistStore() {
  const content = JSON.stringify(persistentStore, null, 2);
  persistQueue = persistQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmpFile = `${STORE_FILE}.tmp`;
    await fs.writeFile(tmpFile, content, "utf8");
    await fs.rename(tmpFile, STORE_FILE);
  });
  return persistQueue;
}

export async function loadStore() {
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

export function getClientBucket(clientId) {
  let bucket = persistentStore.clients[clientId];
  if (!bucket) {
    bucket = normalizeBucket();
    persistentStore.clients[clientId] = bucket;
  }
  // 内存触摸活跃时间，随下一次 persistStore 落盘（避免每次请求都写盘）
  bucket.lastActiveAt = nowIso();
  return bucket;
}

export function listConnections(bucket) {
  return [...bucket.connections].sort((left, right) => {
    const leftScore = left.lastUsedAt || left.updatedAt || left.createdAt;
    const rightScore = right.lastUsedAt || right.updatedAt || right.createdAt;
    return String(rightScore).localeCompare(String(leftScore));
  });
}

export function inferConnectionName(uri, type = "mongo", fallback = "未命名连接") {
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

export function findConnection(bucket, connectionId) {
  return bucket.connections.find((item) => item.id === connectionId) || null;
}

export function findConnectionByUri(bucket, uri, excludeId = null) {
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

export function removeConnection(bucket, connectionId) {
  bucket.connections = bucket.connections.filter((item) => item.id !== connectionId);
  if (bucket.activeConnectionId === connectionId) {
    bucket.activeConnectionId = bucket.connections[0]?.id || null;
  }
}

/**
 * 清理长期不活跃的 client bucket，防止 connections.json 无限增长。
 * 每个访问者（cookie）都会生成一个 bucket；无 TTL 时文件会随访客数无限膨胀。
 * TTL 默认 30 天，可用 CLIENT_TTL_DAYS 环境变量调整（最小 1 天）。
 */
export function cleanupStaleClients({ isActiveClientId = () => false } = {}) {
  const ttlDays = Math.max(1, Number(process.env.CLIENT_TTL_DAYS || 30));
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [clientId, bucket] of Object.entries(persistentStore.clients)) {
    if (isActiveClientId(clientId)) continue;
    const stamps = [
      bucket.lastActiveAt,
      ...(bucket.connections || []).map((c) => c.lastUsedAt || c.updatedAt || c.createdAt),
    ]
      .filter(Boolean)
      .map((s) => Date.parse(s))
      .filter(Number.isFinite);
    const lastActive = stamps.length ? Math.max(...stamps) : 0;
    if (lastActive < cutoff) {
      delete persistentStore.clients[clientId];
      removed += 1;
    }
  }
  return removed;
}
