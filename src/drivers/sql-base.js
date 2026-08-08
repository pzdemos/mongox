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

export function assertIdent(name, label = "标识符") {
  const text = String(name || "").trim();
  if (!text) {
    throw new Error(`${label}不能为空`);
  }
  if (/[^\x00-\x7F]/.test(text) || /[\u4e00-\u9fff]/.test(text)) {
    throw new Error(`${label}不能包含中文或非 ASCII 字符: ${text}`);
  }
  if (!IDENT_RE.test(text)) {
    throw new Error(
      `${label}仅允许字母、数字、下划线，且不能以数字开头（收到: ${text}）`,
    );
  }
  return text;
}

/** 允许常见 SQL 类型字面量，拒绝注入字符 */
export function validateSqlType(type) {
  const text = String(type || "").trim();
  if (!text || text.length > 80) {
    throw new Error("列类型无效");
  }
  if (!/^[A-Za-z][A-Za-z0-9_()\s,]*$/.test(text)) {
    throw new Error(`非法列类型: ${type}`);
  }
  if (/;|--|\/\*|\*\//.test(text)) {
    throw new Error("列类型不允许包含注释或分号");
  }
  return text;
}

/**
 * 归一化索引键：
 * - { col: 1 | -1 }
 * - ["col", "col2"] → 全部 ASC
 */
export function normalizeIndexKeys(keys) {
  if (Array.isArray(keys)) {
    const out = {};
    for (const item of keys) {
      const col = assertIdent(item, "索引列名");
      out[col] = 1;
    }
    if (!Object.keys(out).length) throw new Error("索引列不能为空");
    return out;
  }
  if (!keys || typeof keys !== "object") {
    throw new Error("索引键必须是对象或列名数组");
  }
  const out = {};
  for (const [col, dir] of Object.entries(keys)) {
    const name = assertIdent(col, "索引列名");
    const n = Number(dir);
    out[name] = n === -1 ? -1 : 1;
  }
  if (!Object.keys(out).length) throw new Error("索引列不能为空");
  return out;
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

/** 解开 normalizeRow 产出的扁平标记：{"__sql.date": "..."} 等（不是嵌套 __sql.date） */
export function reviveSqlValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value["__sql.date"] === "string") return value["__sql.date"];
    if (typeof value["__sql.bigint"] === "string") return value["__sql.bigint"];
    if (typeof value["__sql.bytes"] === "string") return value["__sql.bytes"];
  }
  return value;
}

/** 写入 SQL 参数前恢复为驱动原生类型（Date / BigInt / Buffer） */
export function reviveForSql(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value["__sql.date"] === "string") return new Date(value["__sql.date"]);
    if (typeof value["__sql.bigint"] === "string") return BigInt(value["__sql.bigint"]);
    if (typeof value["__sql.bytes"] === "string") {
      return Buffer.from(value["__sql.bytes"], "hex");
    }
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

/** 主键/唯一键冲突（用于导入 skip） */
export function isUniqueViolation(error) {
  if (!error) return false;
  const code = String(error.code || "");
  // PostgreSQL unique_violation
  if (code === "23505") return true;
  // MySQL / MariaDB ER_DUP_ENTRY
  if (code === "1062" || Number(error.errno) === 1062) return true;
  const msg = String(error.message || "").toLowerCase();
  return (
    msg.includes("duplicate") ||
    msg.includes("unique constraint") ||
    msg.includes("unique violation")
  );
}
