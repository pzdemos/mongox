// 连接运行时层：驱动/Mongo 客户端生命周期、健康探测、自适应重连
import { MongoClient } from "mongodb";
import { PostgresDriver } from "./drivers/postgres.js";
import { MysqlDriver } from "./drivers/mysql.js";
import { nowIso, persistStore } from "./store.js";

const runtimeStore = new Map();
const reconnectLocks = new Map();

function runtimeBucket(clientId) {
  if (!runtimeStore.has(clientId)) {
    runtimeStore.set(clientId, new Map());
  }
  return runtimeStore.get(clientId);
}

export function hasActiveRuntime(clientId) {
  return runtimeStore.has(clientId);
}

function runtimeKey(clientId, connectionId) {
  return `${clientId}:${connectionId}`;
}

export function getRuntime(clientId, connectionId) {
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

export async function disconnectAllRuntimes() {
  const jobs = [];
  runtimeStore.forEach((bucket, clientId) => {
    bucket.forEach((_runtime, connectionId) => {
      jobs.push(disconnectRuntime(clientId, connectionId));
    });
  });
  await Promise.allSettled(jobs);
}

/** 运行时引擎类型是否与连接记录一致（防止记录被改类型后复用旧引擎的运行时） */
function runtimeMatchesType(runtime, type) {
  if (!runtime) return false;
  if (type === "mongo") {
    return Boolean(runtime.client) && !runtime.driver;
  }
  return Boolean(runtime.driver) && runtime.driver.type === type;
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

export async function connectWithAdaptiveRetry(uri) {
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

export async function ensureRuntimeConnected(clientId, connection, { persist = true } = {}) {
  const current = getRuntime(clientId, connection.id);
  if (
    runtimeMatchesType(current, connection.type) &&
    (await pingRuntime(current))
  ) {
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
