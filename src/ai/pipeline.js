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
    if (kw === "WITH" && /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|REPLACE)\b/i.test(text)) {
      return "write";
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
  // 无法识别时偏保守：要求确认
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

export function buildAiSystemPrompt({ isSql, dbName, collectionName, indexes }) {
  const dialect = isSql ? "SQL" : "MongoDB shell";
  const indexText = indexes?.length
    ? JSON.stringify(indexes, null, 2)
    : "[]";

  return [
    `你是 ${dialect} 助手，为管理工具生成可执行的单条语句。`,
    "严格规则：",
    "1. 只输出 JSON：{\"statement\":\"...\"}，不要解释。",
    "2. 只生成一条语句，禁止多语句与分号拼接。",
    "3. 优先使用下列索引字段写过滤条件，避免全表/全集合扫描。",
    "4. 查询默认加合理 LIMIT（如 20），除非用户明确要求更多。",
    isSql
      ? `5. 当前库: ${dbName}，表: ${collectionName}。SQL 使用该表，必要时带库名。`
      : [
          `5. 当前库: ${dbName}，集合: ${collectionName}。使用 db.${collectionName}.method(...) 形式。`,
          '6. 过滤条件使用合法 JSON/EJSON：正则请写 {"field":{"$regex":"pat","$options":"i"}}，禁止 /pat/ 字面量；键名建议加双引号。',
        ].join("\n"),
    `索引列表:\n${indexText}`,
  ].join("\n");
}
