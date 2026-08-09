/**
 * AI 生成/执行审计日志（JSONL，落在 data/，已 gitignore）
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const LOG_FILE = path.join(DATA_DIR, "ai-audit.jsonl");

let writeQueue = Promise.resolve();

function safeSlice(text, max = 4000) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function appendAiAudit(entry) {
  const record = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry,
  };
  if (typeof record.prompt === "string") record.prompt = safeSlice(record.prompt, 2000);
  if (typeof record.statement === "string") record.statement = safeSlice(record.statement, 4000);
  if (typeof record.error === "string") record.error = safeSlice(record.error, 1000);
  if (typeof record.planSummary === "string") {
    record.planSummary = safeSlice(record.planSummary, 1500);
  }

  const line = `${JSON.stringify(record)}\n`;
  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.appendFile(LOG_FILE, line, "utf8");
    })
    .catch((err) => {
      console.error("[ai-audit] write failed:", err?.message || err);
    });
  return writeQueue;
}

export function aiAuditContext({ req, connection, driverType }) {
  return {
    clientId: req?.clientId || null,
    connectionId: connection?.id || null,
    connectionName: connection?.name || null,
    driverType: driverType || connection?.type || null,
    dbName: connection?.dbName || null,
    collectionName: connection?.collectionName || null,
  };
}
