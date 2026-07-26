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

// 校验单条 SQL：检测 ; 是否出现在任何字符串/注释之外，且其后仍有内容
// 用于 runCommand 防止多语句注入（MySQL multipleStatements:false 已在协议层拦截，PG 需要应用层校验）
export function assertSingleStatement(sql) {
  const text = String(sql || "");
  const len = text.length;
  let i = 0;
  let sawStatementEnd = false;

  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // 行注释 -- 到行尾
    if (ch === "-" && next === "-") {
      while (i < len && text[i] !== "\n") i++;
      continue;
    }

    // 块注释 /* ... */（允许嵌套是 PG 行为，这里只处理一层足够安全）
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // 单引号字符串（处理 '' 转义和反斜杠转义）
    if (ch === "'") {
      i++;
      while (i < len) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 双引号标识符（PG）
    if (ch === '"') {
      i++;
      while (i < len) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 反引号标识符（MySQL）
    if (ch === "`") {
      i++;
      while (i < len && text[i] !== "`") i++;
      i++;
      continue;
    }

    // PG dollar-quote：$tag$ ... $tag$
    if (ch === "$") {
      const m = text.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (m) {
        const tag = m[0];
        i += tag.length;
        const end = text.indexOf(tag, i);
        i = end === -1 ? len : end + tag.length;
        continue;
      }
    }

    if (ch === ";") {
      sawStatementEnd = true;
      i++;
      continue;
    }

    // 走到此处说明是实际 token；若此前已出现 ; 则属于多语句
    if (sawStatementEnd) {
      throw new Error("不支持多语句 SQL（检测到 ; 后仍有内容）");
    }

    i++;
  }

  return text.trim();
}
