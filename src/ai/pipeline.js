/**
 * AI 语句分类与执行计划启发式判断
 */

import { assertSingleStatement } from "../drivers/sql-base.js";
export { buildAiSystemPrompt } from "./prompts/index.js";

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
    const hasIndex =
      blob.includes("index scan") ||
      blob.includes("index only scan") ||
      blob.includes("bitmap index");
    if (!hasIndex) return true;
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
