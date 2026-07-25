// SQL driver 共享工具：标识符转义、WHERE/ORDER BY 安全检查、结果归一化

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateWhere(where) {
  if (!where) return "";
  const trimmed = String(where).trim();
  if (!trimmed) return "";
  if (/;|--|\/\*|\*\//.test(trimmed)) {
    throw new Error("WHERE 子句不允许出现 ; -- /* */");
  }
  return trimmed;
}

export function validateOrderBy(orderBy) {
  if (!orderBy) return "";
  const trimmed = String(orderBy).trim();
  if (!trimmed) return "";
  if (/;|--|\/\*|\*\//.test(trimmed)) {
    throw new Error("ORDER BY 子句不允许出现 ; -- /* */");
  }
  return trimmed;
}

export function parseLimit(raw, fallback = 20, max = 500) {
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, 1), max);
}

export function quoteIdentPg(name) {
  if (!IDENT_RE.test(name)) {
    throw new Error(`非法标识符: ${name}`);
  }
  return `"${name}"`;
}

export function quoteIdentMysql(name) {
  if (!IDENT_RE.test(name)) {
    throw new Error(`非法标识符: ${name}`);
  }
  return `\`${name}\``;
}

// 把 Date / BigInt / Buffer 等转成可 JSON 序列化的值
export function normalizeRow(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return { "__sql.date": value.toISOString() };
  }
  if (typeof value === "bigint") {
    return { "__sql.bigint": String(value) };
  }
  if (Buffer.isBuffer(value)) {
    return { "__sql.bytes": value.toString("hex") };
  }
  if (Array.isArray(value)) {
    return value.map(normalizeRow);
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeRow(v);
    }
    return out;
  }
  return value;
}

export function reviveSqlValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.__sql.date) return value.__sql.date;
    if (value.__sql.bigint) return value.__sql.bigint;
    if (value.__sql.bytes) return value.__sql.bytes;
  }
  return value;
}
