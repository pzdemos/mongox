// 安全防护层：零依赖限流、过滤器算子黑名单、连接 URI 校验

/**
 * 零依赖固定窗口限流器（按 IP）。
 * IP 取 X-Real-IP（nginx 反代注入），回退 socket remoteAddress。
 * max 可用环境变量覆盖：RATE_LIMIT_PER_MIN / RATE_LIMIT_CONNECT_PER_MIN。
 */
export function createRateLimiter({ windowMs = 60_000, max = 600 } = {}) {
  const hits = new Map(); // key -> { count, windowStart }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.windowStart >= windowMs) {
        hits.delete(key);
      }
    }
  }, windowMs);
  timer.unref();

  return function rateLimiter(req, res, next) {
    const raw = req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
    const key = String(Array.isArray(raw) ? raw[0] : raw);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return res
        .status(429)
        .json({ ok: false, code: "RATE_LIMITED", error: "请求过于频繁，请稍后再试" });
    }
    next();
  };
}

/**
 * 过滤器禁止的 Mongo 算子：这些算子会在数据库端执行 JS。
 * 仅拦截 REST 查询/导出/更新/删除的 filter 入口；终端模式属管理员显式操作不在此列。
 */
const FORBIDDEN_FILTER_OPS = new Set(["$where", "$function", "$accumulator"]);

export function assertSafeFilter(value, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > 24) {
    const error = new Error("过滤器嵌套层级过深");
    error.statusCode = 400;
    throw error;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertSafeFilter(item, depth + 1));
    return value;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FILTER_OPS.has(key)) {
      const error = new Error(`过滤器不允许使用 ${key}（存在数据库端 JS 执行风险）`);
      error.statusCode = 400;
      throw error;
    }
    assertSafeFilter(child, depth + 1);
  }
  return value;
}

/**
 * 连接 URI 最小 SSRF 防护：拒绝云厂商元数据地址（阿里云/EC2 等）。
 * 自建数据库常见内网/回环地址属正常业务，放行。
 */
const BLOCKED_HOSTS = new Set([
  "169.254.169.254", // AWS/GCP/阿里云等链路本地元数据
  "100.100.100.200", // 阿里云 ECS 元数据
  "fd00:ec2::254", // EC2 IPv6 元数据
]);

const ALLOWED_SCHEMES = new Set([
  "mongodb",
  "mongodb+srv",
  "postgres",
  "postgresql",
  "mysql",
  "mariadb",
]);

function badUri(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function assertSafeConnectionUri(uri) {
  const text = String(uri || "").trim();
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(text);
  if (!schemeMatch) {
    throw badUri("连接字符串格式无效");
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    throw badUri(`不支持的连接协议: ${scheme}`);
  }

  // 取 authority 段（兼容 host1,host2 值列表与 IPv6）
  const authority = text.slice(schemeMatch[0].length).split(/[/?#]/)[0];
  const hostPart = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  const hosts = hostPart
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) =>
      h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.split(":")[0],
    );

  for (const host of hosts) {
    const normalized = String(host).toLowerCase().replace(/^\[|\]$/g, "");
    if (BLOCKED_HOSTS.has(normalized)) {
      throw badUri(`出于安全考虑，不允许连接到 ${normalized}`);
    }
  }
}
