// 账号体系：SQLite（better-sqlite3）存储用户/会话/AI 用量
// —— 邮箱验证码注册（SMTP 配置见环境变量，设计参照 common-design）、
//    scrypt 密码哈希、会话 Cookie、AI 调用额度原子扣减与使用留痕
// 门控范围：仅 AI 端点要求登录；站点其余工具功能保持公开。
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { Router } from "express";
import nodemailer from "nodemailer";
import Database from "better-sqlite3";
import { createRateLimiter } from "./security.js";
import { DATA_DIR } from "./store.js";

const DB_FILE = process.env.ACCOUNTS_DB || path.join(DATA_DIR, "accounts.db");
const REGISTER_BONUS_QUOTA = Math.max(0, Number(process.env.REGISTER_BONUS_QUOTA || 1000));
const ADMIN_DEFAULT_QUOTA = Math.max(1, Number(process.env.ADMIN_QUOTA || 10000));
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 天
const AUTH_COOKIE = "mongox_auth";
const CODE_TTL_MS = 10 * 60 * 1000; // 验证码 10 分钟有效
const CODE_RESEND_COOLDOWN_MS = 60 * 1000; // 同邮箱重发冷却
const CODE_MAX_ATTEMPTS = 5; // 单码最大校验次数

// ---------- SQLite 初始化 ----------

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL UNIQUE,
    pwd_hash   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'user',
    quota      INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_usage (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    email      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    endpoint   TEXT NOT NULL,
    engine     TEXT,
    database   TEXT,
    collection TEXT,
    prompt     TEXT,
    statement  TEXT,
    ok         INTEGER NOT NULL,
    error      TEXT
  );
`);

// ---------- 密码（scrypt）与会话 ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${key}`;
}

function verifyPassword(password, stored) {
  const [salt, keyHex] = String(stored || "").split(":");
  if (!salt || !keyHex) return false;
  const key = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(keyHex, "hex");
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(sha256(token), userId, now, Date.now() + SESSION_TTL_MS);
  // 惰性清理过期会话
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** 从请求 Cookie 解析登录用户；未登录返回 null */
export function resolveAuthUser(req) {
  const token = parseCookies(req.headers.cookie || "")[AUTH_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.role, u.quota, u.used FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .get(sha256(token), Date.now());
  return row || null;
}

// ---------- 邮箱验证码（内存态，短命数据无需入库） ----------

/** email -> { codeHash, expiresAt, attempts, sentAt } */
const pendingCodes = new Map();

let transporter = null;
function getTransporter() {
  const host = String(process.env.EMAIL_HOST || "").trim();
  const user = String(process.env.EMAIL_USER || "").trim();
  const pass = String(process.env.EMAIL_PASS || "").trim();
  if (!host || !user || !pass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.EMAIL_PORT || 465),
      secure: Number(process.env.EMAIL_PORT || 465) === 465,
      auth: { user, pass },
    });
  }
  return transporter;
}

export function isEmailConfigured() {
  return Boolean(getTransporter()) || process.env.ACCOUNTS_DEV_CODE === "1";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

function pruneCodes() {
  const now = Date.now();
  for (const [email, entry] of pendingCodes) {
    if (entry.expiresAt < now) pendingCodes.delete(email);
  }
}

// SqlX 品牌验证码邮件：暖墨 + 米纸 + 翡翠渐变（与站点视觉同源）
function buildCodeEmailHtml(code) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>SqlX 验证码</title></head>
<body style="margin:0;padding:0;background-color:#f0eadf;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0eadf;padding:40px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background-color:#f8f5ee;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(43,37,30,0.06),0 16px 40px rgba(43,37,30,0.08);">
        <tr><td style="position:relative;overflow:hidden;background:linear-gradient(135deg,#1a9d6e 0%,#0e6b4b 100%);padding:36px 40px 30px 40px;text-align:center;">
          <table cellpadding="0" cellspacing="0" style="margin:0 auto 18px auto;"><tr><td style="background:rgba(248,245,238,0.14);border-radius:12px;padding:12px 16px;border:1px solid rgba(248,245,238,0.22);">
            <span style="color:#f8f5ee;font-size:20px;font-weight:700;letter-spacing:1px;font-family:'Space Grotesk','Segoe UI',sans-serif;">SqlX</span>
          </td></tr></table>
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#f8f5ee;letter-spacing:-0.3px;">邮箱验证码</h1>
          <p style="margin:8px 0 0 0;font-size:14px;color:rgba(248,245,238,0.75);line-height:1.5;">注册 SqlX 账号，10 分钟内有效</p>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#efe9db;border-radius:12px;border:1px solid #ded5c6;">
            <tr><td style="padding:28px;text-align:center;">
              <div style="font-size:11px;font-weight:600;color:#8c8170;letter-spacing:2px;text-transform:uppercase;padding-bottom:12px;">验证码</div>
              <span style="font-size:36px;font-weight:700;color:#14855e;letter-spacing:8px;font-family:'SF Mono','JetBrains Mono','Fira Code',Consolas,monospace;">${code}</span>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;background-color:#f1ece0;border-radius:10px;">
            <tr><td style="padding:14px 18px;">
              <p style="margin:0;font-size:13px;color:#4a4338;line-height:1.6;"><strong style="color:#14855e;">安全提醒：</strong>请勿将验证码告知他人。如非本人操作，请忽略此邮件。</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="background-color:#f1ece0;border-top:1px solid #e2dac9;padding:18px 40px;text-align:center;">
          <span style="color:#14855e;text-decoration:none;font-size:13px;font-weight:600;">haoaiganfan.top</span>
          <p style="margin:6px 0 0 0;font-size:12px;color:#8c8170;">此邮件由 SqlX 系统自动发送，请勿直接回复</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendCodeEmail(email, code) {
  if (process.env.ACCOUNTS_DEV_CODE === "1") {
    console.log(`[accounts][dev] 验证码 ${email}: ${code}`);
    return;
  }
  const mailer = getTransporter();
  if (!mailer) throw Object.assign(new Error("邮件服务未配置"), { code: "EMAIL_NOT_CONFIGURED" });
  const user = String(process.env.EMAIL_USER || "").trim();
  await mailer.sendMail({
    from: `"SqlX" <${user}>`,
    to: email,
    subject: "SqlX 邮箱验证码",
    text: `您的 SqlX 验证码：${code}，10 分钟内有效。如非本人操作请忽略。`,
    html: buildCodeEmailHtml(code),
  });
}

// ---------- 额度：原子扣减 / 退还 / 留痕 ----------

/**
 * AI 端点门控中间件：要求已登录 + 预扣 1 次额度（失败自动退还）。
 * 通过后 req.aiCall = { userId, email, state: 'pending' }
 */
export function aiGate(req, res, next) {
  const user = resolveAuthUser(req);
  if (!user) {
    return res.status(401).json({
      ok: false,
      code: "AI_AUTH_REQUIRED",
      error: "AI 模式需要登录后使用，请先登录或注册",
    });
  }
  const r = db
    .prepare("UPDATE users SET quota = quota - 1, used = used + 1 WHERE id = ? AND quota > 0")
    .run(user.id);
  if (r.changes === 0) {
    return res.status(403).json({
      ok: false,
      code: "QUOTA_EXHAUSTED",
      error: "AI 额度已用完，请联系管理员补充",
      remaining: 0,
    });
  }
  req.aiCall = { userId: user.id, email: user.email, state: "pending" };
  next();
}

/** AI 调用成功：落一条成功用量记录 */
export function commitAiCall(req, meta = {}) {
  if (!req.aiCall || req.aiCall.state !== "pending") return;
  req.aiCall.state = "committed";
  recordUsage(req, { ...meta, ok: 1, error: null });
}

/** AI 调用失败：退还额度并落失败记录（未扣减/已提交时为幂等空操作） */
export function abortAiCall(req, error) {
  if (!req.aiCall || req.aiCall.state !== "pending") return;
  req.aiCall.state = "aborted";
  db.prepare("UPDATE users SET quota = quota + 1, used = used - 1 WHERE id = ?").run(
    req.aiCall.userId
  );
  recordUsage(req, { ok: 0, error: String(error?.message || error || "").slice(0, 500) });
}

function recordUsage(req, { endpoint, engine, database, collection, prompt, statement, ok, error }) {
  db.prepare(
    `INSERT INTO ai_usage (user_id, email, created_at, endpoint, engine, database, collection, prompt, statement, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.aiCall.userId,
    req.aiCall.email,
    new Date().toISOString(),
    endpoint || req.path || "",
    engine || null,
    database || null,
    collection || null,
    prompt ? String(prompt).slice(0, 1000) : null,
    statement ? String(statement).slice(0, 2000) : null,
    ok,
    error
  );
}

// ---------- 认证路由 ----------

const sendCodeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 }); // 单 IP 每小时 5 次

export const accountsRouter = Router();

function publicUser(row) {
  return { email: row.email, role: row.role, quota: row.quota, used: row.used };
}

accountsRouter.post("/auth/send-code", sendCodeLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, code: "INVALID_INPUT", error: "邮箱格式不正确" });
  }
  pruneCodes();
  const existing = pendingCodes.get(email);
  if (existing && Date.now() - existing.sentAt < CODE_RESEND_COOLDOWN_MS) {
    return res.status(429).json({
      ok: false,
      code: "CODE_COOLDOWN",
      error: "发送过于频繁，请 1 分钟后再试",
    });
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆字符
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[crypto.randomInt(alphabet.length)];
  }
  pendingCodes.set(email, {
    codeHash: sha256(code),
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
    sentAt: Date.now(),
  });
  try {
    await sendCodeEmail(email, code);
  } catch (error) {
    pendingCodes.delete(email);
    console.error("[accounts] 验证码邮件发送失败:", error.message);
    const devEcho = process.env.ACCOUNTS_DEV_CODE === "1";
    return res.status(502).json({
      ok: false,
      code: devEcho ? "EMAIL_DEV_MODE" : "EMAIL_SEND_FAILED",
      error: devEcho ? `开发模式验证码: ${code}` : "验证码邮件发送失败，请稍后重试",
      ...(devEcho ? { devCode: code } : {}),
    });
  }
  return res.json({
    ok: true,
    expiresIn: CODE_TTL_MS / 1000,
    ...(process.env.ACCOUNTS_DEV_CODE === "1" ? { devCode: code } : {}),
  });
});

accountsRouter.post("/auth/register", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || "").trim().toUpperCase();
  const password = String(req.body?.password || "");

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, code: "INVALID_INPUT", error: "邮箱格式不正确" });
  }
  if (password.length < 8) {
    return res.status(400).json({
      ok: false,
      code: "WEAK_PASSWORD",
      error: "密码至少需要 8 位",
    });
  }
  pruneCodes();
  const entry = pendingCodes.get(email);
  if (!entry) {
    return res
      .status(400)
      .json({ ok: false, code: "CODE_INVALID", error: "请先获取邮箱验证码" });
  }
  if (entry.expiresAt < Date.now()) {
    pendingCodes.delete(email);
    return res
      .status(400)
      .json({ ok: false, code: "CODE_EXPIRED", error: "验证码已过期，请重新获取" });
  }
  entry.attempts += 1;
  if (entry.attempts > CODE_MAX_ATTEMPTS) {
    pendingCodes.delete(email);
    return res
      .status(400)
      .json({ ok: false, code: "CODE_INVALID", error: "验证码错误次数过多，请重新获取" });
  }
  if (entry.codeHash !== sha256(code)) {
    return res.status(400).json({ ok: false, code: "CODE_INVALID", error: "验证码不正确" });
  }
  pendingCodes.delete(email);

  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
    return res.status(409).json({ ok: false, code: "EMAIL_TAKEN", error: "该邮箱已注册，请直接登录" });
  }
  const info = db
    .prepare(
      "INSERT INTO users (email, pwd_hash, role, quota, created_at) VALUES (?, ?, 'user', ?, ?)"
    )
    .run(email, hashPassword(password), REGISTER_BONUS_QUOTA, new Date().toISOString());
  createSession(res, info.lastInsertRowid);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  return res.json({ ok: true, user: publicUser(user) });
});

accountsRouter.post("/auth/login", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !verifyPassword(password, user.pwd_hash)) {
    return res.status(401).json({ ok: false, code: "INVALID_CREDENTIALS", error: "邮箱或密码不正确" });
  }
  createSession(res, user.id);
  return res.json({ ok: true, user: publicUser(user) });
});

accountsRouter.post("/auth/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie || "")[AUTH_COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  clearSession(res);
  return res.json({ ok: true });
});

accountsRouter.get("/auth/me", (req, res) => {
  const user = resolveAuthUser(req);
  return res.json({ ok: true, user: user ? publicUser(user) : null });
});

// ---------- 管理员 CLI 支撑 ----------

export function createAdmin(email, password, quota = ADMIN_DEFAULT_QUOTA) {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized)) throw new Error("邮箱格式不正确");
  if (String(password).length < 8) throw new Error("密码至少需要 8 位");
  const existing = db.prepare("SELECT id, role FROM users WHERE email = ?").get(normalized);
  if (existing) {
    db.prepare("UPDATE users SET role = 'admin', quota = ? WHERE id = ?").run(quota, existing.id);
    return { email: normalized, role: "admin", quota, updated: true };
  }
  db.prepare(
    "INSERT INTO users (email, pwd_hash, role, quota, created_at) VALUES (?, ?, 'admin', ?, ?)"
  ).run(normalized, hashPassword(password), quota, new Date().toISOString());
  return { email: normalized, role: "admin", quota, updated: false };
}

export function listUsers() {
  return db
    .prepare("SELECT id, email, role, quota, used, created_at FROM users ORDER BY id")
    .all();
}

export function setQuota(email, quota) {
  const r = db.prepare("UPDATE users SET quota = ? WHERE email = ?").run(Math.max(0, quota | 0), normalizeEmail(email));
  return r.changes > 0;
}

export function listUsage(limit = 20) {
  return db
    .prepare(
      "SELECT created_at, email, endpoint, engine, database, collection, ok, substr(prompt,1,60) AS prompt, substr(error,1,80) AS error FROM ai_usage ORDER BY id DESC LIMIT ?"
    )
    .all(limit);
}
