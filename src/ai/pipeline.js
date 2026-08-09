/**
 * AI 语句分类与执行计划启发式判断
 */

import { assertSingleStatement } from "../drivers/sql-base.js";

const READ_SQL = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH"]);
const MONGO_READ_RE =
  /\.(find|findOne|aggregate|count|countDocuments|estimatedDocumentCount|distinct)\s*\(/i;

export function classifyStatement(statement, isSql) {
  const text = String(statement || "").trim();
  if (!text) return "write";

  if (isSql) {
    assertSingleStatement(text);
    const stripped = text.replace(/^\(+/, "").trim();
    const kw = (stripped.match(/^([A-Za-z]+)/) || [])[1]?.toUpperCase() || "";
    const hasWriteVerb =
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|REPLACE)\b/i.test(text);
    if (kw === "WITH") {
      return hasWriteVerb ? "write" : "read";
    }
    if (READ_SQL.has(kw)) return "read";
    return "write";
  }

  if (MONGO_READ_RE.test(text)) return "read";
  return "write";
}

function mysqlFullScan(rows) {
  return rows.some((row) => {
    const type = String(row?.type || "").toUpperCase();
    return type === "ALL";
  });
}

function postgresFullScan(rows) {
  const blob = JSON.stringify(rows || []).toLowerCase();
  if (
    blob.includes('"nodetype":"seq scan"') ||
    blob.includes('"node type":"seq scan"') ||
    blob.includes("seq scan")
  ) {
    // 若同时有 index scan，仍可能混用；偏保守：出现 seq scan 即视为未充分走索引
    const hasIndex =
      blob.includes("index scan") ||
      blob.includes("index only scan") ||
      blob.includes("bitmap index");
    if (!hasIndex) return true;
    // 有 index 也有 seq scan：仍要求确认
    return true;
  }
  return rows.some((row) => {
    const plan = String(row?.["QUERY PLAN"] || JSON.stringify(row) || "").toLowerCase();
    return plan.includes("seq scan");
  });
}

function mongoUsesIndex(explainDoc) {
  const blob = JSON.stringify(explainDoc || {}).toLowerCase();
  if (blob.includes('"stage":"collscan"') || blob.includes('"stage": "collscan"')) {
    return false;
  }
  if (blob.includes("ixscan") || blob.includes("idhack") || blob.includes("express_ixscan")) {
    return true;
  }
  if (blob.includes("collscan")) return false;
  return true;
}

export async function analyzePlan({ isSql, driverType, statement, runExplain }) {
  try {
    const explained = await runExplain(statement);
    if (!explained) {
      return { usesIndex: false, planSummary: "无法获取执行计划", raw: null };
    }

    if (isSql) {
      const rows = Array.isArray(explained.docs)
        ? explained.docs
        : Array.isArray(explained)
          ? explained
          : [];
      const fullScan =
        driverType === "postgres" ? postgresFullScan(rows) : mysqlFullScan(rows);
      const usesIndex = rows.length > 0 ? !fullScan : false;
      return {
        usesIndex,
        planSummary: JSON.stringify(rows.slice(0, 8), null, 2).slice(0, 4000),
        raw: rows,
      };
    }

    const usesIndex = mongoUsesIndex(explained);
    return {
      usesIndex,
      planSummary: JSON.stringify(explained, null, 2).slice(0, 4000),
      raw: explained,
    };
  } catch (error) {
    return {
      usesIndex: false,
      planSummary: `执行计划失败: ${error.message || error}`,
      raw: null,
    };
  }
}

function dialectRules({ driverType, dbName, collectionName }) {
  const table = collectionName || "table";
  const db = dbName || "db";

  if (driverType === "postgres") {
    return [
      "方言: PostgreSQL（不是 MySQL）。",
      `当前已连接数据库: ${db}。表位于 schema public。`,
      `引用表请用 public."${table}" 或 "${table}"，禁止写成 ${db}.${table}（那会把库名误当成 schema）。`,
      "字符串拼接用 || ，不要用 CONCAT（除非必要）。",
      "UPDATE/DELETE 限制行数时必须用 CTE，禁止同表 IN (SELECT ... LIMIT)：",
      `示例: WITH targets AS (SELECT id FROM public."${table}" WHERE ... LIMIT 20) UPDATE public."${table}" SET ... WHERE id IN (SELECT id FROM targets);`,
      "LIMIT 仅用于 SELECT/CTE；不要写 MySQL 风格 UPDATE ... LIMIT。",
    ].join("\n");
  }

  if (driverType === "mysql") {
    return [
      "方言: MySQL。",
      `当前库: ${db}，表: ${table}。可用 \`${db}\`.\`${table}\` 或 \`${table}\`。`,
      "字符串拼接可用 CONCAT(...)。",
      `更新限行可用: UPDATE \`${table}\` SET ... WHERE ... LIMIT 20;`,
    ].join("\n");
  }

  // mongo
  return [
    "方言: MongoDB shell。",
    `当前库: ${db}，集合: ${table}。使用 db.${table}.method(...) 形式。`,
    '过滤条件使用合法 JSON/EJSON：正则请写 {"field":{"$regex":"pat","$options":"i"}}，禁止 /pat/ 字面量；键名建议加双引号。',
  ].join("\n");
}

export function buildAiSystemPrompt({ driverType, dbName, collectionName, indexes, todayIso }) {
  const type = String(driverType || "mongo").toLowerCase();
  const dialectLabel =
    type === "postgres" ? "PostgreSQL" : type === "mysql" ? "MySQL" : "MongoDB shell";
  const indexText = indexes?.length ? JSON.stringify(indexes, null, 2) : "[]";
  const today = todayIso || new Date().toISOString().slice(0, 10);

  return [
    `你是 ${dialectLabel} 助手，为管理工具生成可执行的单条语句。`,
    "严格规则：",
    '1. 只输出 JSON：{"statement":"..."}，不要解释。',
    "2. 只生成一条语句，禁止多语句与分号拼接。",
    "3. 优先使用下列索引字段写过滤条件，避免全表/全集合扫描。",
    "4. 查询默认加合理 LIMIT（如 20），除非用户明确要求更多。",
    `5. 今天日期（UTC+8 日历）是 ${today}。用户只说月日未说年份时，默认用 ${today.slice(0, 4)} 年；不要臆造其它年份。`,
    "6. 日期范围用半开区间：>= 当天 00:00 且 < 次日，字段名以用户/表结构为准（如 ts、created_at）。",
    dialectRules({ driverType: type, dbName, collectionName }),
    `索引列表:\n${indexText}`,
  ].join("\n");
}
