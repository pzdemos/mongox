/**
 * MongoDB AI 系统提示词
 */

import {
  appendContextTail,
  formatContextBlocks,
  sharedOutputRules,
} from "./shared.js";

function isEjsonDateValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("$date" in value)) return false;
  const d = value.$date;
  return typeof d === "string" || (d && typeof d === "object" && "$numberLong" in d);
}

function detectStringTimeFields(sampleRows = []) {
  const hits = new Set();
  const re = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/;
  for (const row of sampleRows) {
    if (!row || typeof row !== "object") continue;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string" && re.test(value)) hits.add(key);
    }
  }
  return [...hits];
}

function detectBsonDateFields(sampleRows = []) {
  const hits = new Set();
  for (const row of sampleRows) {
    if (!row || typeof row !== "object") continue;
    for (const [key, value] of Object.entries(row)) {
      if (isEjsonDateValue(value)) hits.add(key);
    }
  }
  return [...hits];
}

function mongoDialectRules({ dbName, collectionName, sampleRows }) {
  const table = collectionName || "collection";
  const db = dbName || "db";
  const stringTimeFields = detectStringTimeFields(sampleRows);
  const bsonDateFields = detectBsonDateFields(sampleRows);
  const timeRules = [];

  if (bsonDateFields.length) {
    timeRules.push(
      `BSON Date 字段（EJSON $date / $numberLong）：${bsonDateFields.join(", ")}。`,
      "用户口中的时间默认按 Asia/Shanghai（UTC+8）理解，再转换成 UTC 的 EJSON 比较。",
      '示例：用户说 2026-01-21 22:19 → {"acceptedAt":{"$gte":{"$date":"2026-01-21T14:19:00.000Z"},"$lt":{"$date":"2026-01-21T14:20:00.000Z"}}}。',
      "禁止把 Date 字段当字符串比较；不要写 \"2026-01-21 22:19:00\" 去匹配 $date 字段。",
      '过滤里优先写 {"$date":"ISO-UTC"}；ISODate("...") 的参数也必须是 UTC ISO 字符串。',
    );
  }

  if (stringTimeFields.length) {
    timeRules.push(
      `字符串时间字段：${stringTimeFields.join(", ")}。`,
      '必须用同格式字符串比较，例如 "2026-01-21 22:19:00"；禁止对字符串字段用 Date/$date。',
      '「某日某分」用半开区间：{"field":{"$gte":"2026-01-21 22:19:00","$lt":"2026-01-21 22:20:00"}}。',
    );
  }

  if (!timeRules.length) {
    timeRules.push(
      "时间字段类型以样例为准：出现 $date 用 EJSON 日期（默认 UTC+8→UTC）；普通字符串则按字符串比较。",
    );
  }

  return [
    "方言: MongoDB shell（不是 SQL）。",
    `当前库: ${db}，集合: ${table}。必须使用 db.${table}.method(...) 形式。`,
    '过滤条件使用合法 JSON/EJSON；正则写 {"field":{"$regex":"pat","$options":"i"}}，禁止 /pat/ 字面量；键名建议加双引号。',
    "常用只读：find / findOne / aggregate / countDocuments；写操作：insertOne/updateOne/deleteOne 等。",
    "find 后可链式 .sort().limit().skip()；默认 .limit(20)。",
    ...timeRules,
  ];
}

export function buildMongoSystemPrompt(ctx) {
  const { dbName, collectionName, sampleRows } = ctx;
  const blocks = formatContextBlocks(ctx);

  return [
    "你是 MongoDB shell 助手，为管理工具生成可执行的单条语句。",
    "严格规则：",
    ...sharedOutputRules(blocks),
    ...mongoDialectRules({ dbName, collectionName, sampleRows }),
    ...appendContextTail(blocks),
  ].join("\n");
}
