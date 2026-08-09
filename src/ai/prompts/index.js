/**
 * 按驱动类型选择 AI 系统提示词
 */

import { buildMongoSystemPrompt } from "./mongo.js";
import { buildMysqlSystemPrompt } from "./mysql.js";
import { buildPostgresSystemPrompt } from "./postgres.js";

export function buildAiSystemPrompt(ctx = {}) {
  const type = String(ctx.driverType || "mongo").toLowerCase();
  if (type === "postgres") return buildPostgresSystemPrompt(ctx);
  if (type === "mysql") return buildMysqlSystemPrompt(ctx);
  return buildMongoSystemPrompt(ctx);
}
