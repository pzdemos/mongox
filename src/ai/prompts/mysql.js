/**
 * MySQL AI 系统提示词
 */

import {
  appendContextTail,
  formatContextBlocks,
  sharedOutputRules,
} from "./shared.js";

function mysqlDialectRules({ dbName, collectionName }) {
  const table = collectionName || "table";
  const db = dbName || "db";

  return [
    "方言: MySQL（不是 PostgreSQL，不是 MongoDB）。",
    `当前库: ${db}，表: ${table}。`,
    `引用表可用 \`${db}\`.\`${table}\` 或 \`${table}\`。`,
    "字符串拼接可用 CONCAT(...)。",
    `更新限行可用: UPDATE \`${table}\` SET ... WHERE ... LIMIT 20;`,
    "日期时间按列真实类型比较；用户时间默认理解为业务本地时间（Asia/Shanghai），按列类型写入字面量。",
    "半开区间查某日：col >= 'YYYY-MM-DD' AND col < 次日。",
    "禁止输出 PostgreSQL 的 public.\"table\"、|| 拼接、或 WITH...UPDATE CTE（除非确有必要且语法正确）。",
    "禁止输出 MongoDB shell。",
  ];
}

export function buildMysqlSystemPrompt(ctx) {
  const { dbName, collectionName } = ctx;
  const blocks = formatContextBlocks(ctx);

  return [
    "你是 MySQL 助手，为管理工具生成可执行的单条 SQL。",
    "严格规则：",
    ...sharedOutputRules(blocks),
    ...mysqlDialectRules({ dbName, collectionName }),
    ...appendContextTail(blocks),
  ].join("\n");
}
