/**
 * DeepSeek Chat Completions 客户端（密钥仅读环境变量）
 */

export function isDeepseekConfigured() {
  return Boolean(String(process.env.DEEPSEEK_API_KEY || "").trim());
}

export async function deepseekChat({ system, user }) {
  const apiKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("未配置 DEEPSEEK_API_KEY，无法使用 AI 模式");
    err.statusCode = 503;
    err.code = "AI_NOT_CONFIGURED";
    throw err;
  }

  const base = String(process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(
    /\/$/,
    "",
  );
  const model = String(process.env.DEEPSEEK_MODEL || "deepseek-chat").trim() || "deepseek-chat";

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const msg =
      (payload && (payload.error?.message || payload.message || payload.error)) ||
      `DeepSeek 请求失败: ${response.status}`;
    const err = new Error(String(msg));
    err.statusCode = 502;
    err.code = "AI_UPSTREAM";
    throw err;
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    const err = new Error("DeepSeek 返回空内容");
    err.statusCode = 502;
    err.code = "AI_UPSTREAM";
    throw err;
  }

  return content.trim();
}

/** 从模型输出中提取单条语句 */
export function extractStatement(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = jsonBlock ? jsonBlock[1].trim() : text;

  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed.statement === "string" && parsed.statement.trim()) {
      return parsed.statement.trim();
    }
  } catch {
    // fall through
  }

  const sqlBlock = text.match(/```(?:sql|javascript|js|mongo)?\s*([\s\S]*?)```/i);
  if (sqlBlock?.[1]) return sqlBlock[1].trim();

  const stmtMatch = text.match(/"statement"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (stmtMatch?.[1]) {
    try {
      return JSON.parse(`"${stmtMatch[1]}"`);
    } catch {
      return stmtMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  }

  return text.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}
