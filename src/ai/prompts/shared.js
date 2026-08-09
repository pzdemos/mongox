/**
 * AI 提示词共用上下文（表结构 / 索引 / 样例行 / 日期）
 */

export function formatContextBlocks({ columns, indexes, sampleRows, todayIso }) {
  const indexText = indexes?.length ? JSON.stringify(indexes, null, 2) : "[]";
  const columnsText = columns?.length ? JSON.stringify(columns, null, 2) : "[]";
  const sampleText = sampleRows?.length
    ? JSON.stringify(sampleRows, null, 2).slice(0, 4000)
    : "[]";
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const columnNames = (columns || [])
    .map((c) => c?.name)
    .filter(Boolean)
    .join(", ");

  return { indexText, columnsText, sampleText, today, columnNames };
}

export function sharedOutputRules({ today, columnNames }) {
  return [
    '1. 只输出 JSON：{"statement":"..."}，不要解释。',
    "2. 只生成一条语句，禁止多语句与分号拼接。",
    "3. 只能使用「表结构/字段列表」中真实存在的字段名；严禁臆造列名。",
    `4. 当前可用字段: ${columnNames || "(未知，请仅用最新样例行中出现的键)"}。`,
    "5. 优先使用下列索引字段写过滤条件，避免全表/全集合扫描。",
    "6. 查询默认加合理 LIMIT（如 20），除非用户明确要求更多。",
    `7. 今天日期（UTC+8 日历）是 ${today}。用户只说月日未说年份时，默认用 ${today.slice(0, 4)} 年；不要臆造其它年份。`,
    "8. 下方「最新 3 条具体数据」用于理解真实字段名、值格式与业务含义；条件必须与这些字段一致。",
  ];
}

export function appendContextTail({ columnsText, indexText, sampleText }) {
  return [
    `表结构/字段列表:\n${columnsText}`,
    `索引列表:\n${indexText}`,
    `最新 3 条具体数据:\n${sampleText}`,
  ];
}
