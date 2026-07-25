// MySQL driver，基于 mysql2/promise
import mysql from "mysql2/promise";
import {
  validateWhere,
  validateOrderBy,
  parseLimit,
  quoteIdentMysql,
  normalizeRow,
} from "./sql-base.js";

const SYSTEM_DBS = new Set([
  "information_schema",
  "performance_schema",
  "mysql",
  "sys",
]);

export class MysqlDriver {
  constructor(uri) {
    this.type = "mysql";
    this.uri = uri;
    this.pool = null;
    this.dbName = "";
  }

  async connect() {
    this.pool = mysql.createPool({
      uri: this.uri,
      connectionLimit: 5,
      multipleStatements: false,
      connectTimeout: 10000,
    });
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query("SELECT DATABASE() AS name");
      this.dbName = rows[0]?.name || "";
    } finally {
      conn.release();
    }
  }

  async disconnect() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async listDatabases() {
    const [rows] = await this.pool.query("SHOW DATABASES");
    return rows
      .map((r) => r.Database)
      .filter((n) => !SYSTEM_DBS.has(n))
      .map((name) => ({ name }));
  }

  async listTables(dbName) {
    const [rows] = await this.pool.query(
      `SHOW TABLES FROM ${quoteIdentMysql(dbName)}`,
    );
    const key = Object.keys(rows[0] || {})[0];
    return rows.map((r) => ({ name: r[key] })).filter((r) => r.name);
  }

  async query(dbName, table, { where = "", orderBy = "", limit = 20 } = {}) {
    const w = validateWhere(where);
    const ob = validateOrderBy(orderBy);
    const lim = parseLimit(limit);

    const tableIdent = `${quoteIdentMysql(dbName)}.${quoteIdentMysql(table)}`;
    const sql = `SELECT * FROM ${tableIdent}${w ? ` WHERE ${w}` : ""}${
      ob ? ` ORDER BY ${ob}` : ""
    } LIMIT ${lim}`;

    const [rows] = await this.pool.query(sql);
    return { docs: rows.map(normalizeRow), sql };
  }

  async insert(dbName, table, doc) {
    const keys = Object.keys(doc);
    if (!keys.length) throw new Error("插入内容不能为空");
    const cols = keys.map(quoteIdentMysql).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const params = keys.map((k) => reviveForSql(doc[k]));
    const sql = `INSERT INTO ${quoteIdentMysql(dbName)}.${quoteIdentMysql(
      table,
    )} (${cols}) VALUES (${placeholders})`;
    const [res] = await this.pool.query(sql, params);
    return { inserted: res.affectedRows, returning: [] };
  }

  async update(dbName, table, { where = "", setDoc = {} } = {}) {
    const w = validateWhere(where);
    const keys = Object.keys(setDoc);
    if (!keys.length) throw new Error("SET 内容不能为空");
    const sets = keys.map((k) => `${quoteIdentMysql(k)} = ?`).join(", ");
    const params = keys.map((k) => reviveForSql(setDoc[k]));
    const sql = `UPDATE ${quoteIdentMysql(dbName)}.${quoteIdentMysql(
      table,
    )} SET ${sets}${w ? ` WHERE ${w}` : ""}`;
    const [res] = await this.pool.query(sql, params);
    return { updated: res.affectedRows };
  }

  async delete(dbName, table, { where = "" } = {}) {
    const w = validateWhere(where);
    if (!w) throw new Error("DELETE 必须提供 WHERE 条件");
    const sql = `DELETE FROM ${quoteIdentMysql(dbName)}.${quoteIdentMysql(
      table,
    )} WHERE ${w}`;
    const [res] = await this.pool.query(sql);
    return { deleted: res.affectedRows };
  }

  async stats(dbName, table) {
    const [countRows] = await this.pool.query(
      `SELECT COUNT(*) AS c FROM ${quoteIdentMysql(dbName)}.${quoteIdentMysql(table)}`,
    );
    const count = Number(countRows[0]?.c ?? 0);

    const [statRows] = await this.pool.query(
      `SELECT * FROM information_schema.tables
       WHERE table_schema = ? AND table_name = ?`,
      [dbName, table],
    );
    const s = statRows[0] || {};

    return {
      estimatedCount: count,
      accurateCount: count,
      size: Number(s.data_length ?? 0),
      storageSize: Number(s.data_length ?? 0) + Number(s.index_length ?? 0),
      nIndexes: null,
      avgObjSize: count > 0 ? Math.round(Number(s.data_length ?? 0) / count) : 0,
      totalIndexSize: Number(s.index_length ?? 0),
      freeStorageSize: Number(s.data_free ?? 0),
      indexSizes: {},
    };
  }

  async indexes(dbName, table) {
    const [rows] = await this.pool.query(
      `SHOW INDEX FROM ${quoteIdentMysql(dbName)}.${quoteIdentMysql(table)}`,
    );
    const groups = new Map();
    for (const r of rows) {
      const name = r.Key_name;
      if (!groups.has(name)) {
        groups.set(name, {
          name,
          key: {},
          unique: !r.Non_unique,
          sparse: false,
        });
      }
      groups.get(name).key[r.Column_name] = r.Collation === "A" ? 1 : -1;
    }
    return [...groups.values()];
  }

  async runCommand(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new Error("SQL 不能为空");
    const [rows, meta] = await this.pool.query(trimmed);

    if (Array.isArray(rows) && rows.length && rows[0] && typeof rows[0] === "object") {
      const fields = meta && Array.isArray(meta) ? meta.map((m) => m.name) : Object.keys(rows[0]);
      return {
        resultType: "rows",
        docs: rows.map(normalizeRow),
        rowCount: rows.length,
        fields,
      };
    }
    const affected = typeof rows.affectedRows === "number" ? rows.affectedRows : 0;
    return {
      resultType: "exec",
      rowCount: affected,
      message: `影响的行数: ${affected}`,
    };
  }

  async searchTables(keyword) {
    const kw = String(keyword || "").trim().toLowerCase();
    if (!kw) return { matches: [], truncated: false };

    const dbList = await this.listDatabases();
    const matches = [];
    let truncated = false;
    const limit = 100;

    for (const { name: dbName } of dbList) {
      if (truncated) break;
      try {
        const [rows] = await this.pool.query(
          `SHOW TABLES FROM ${quoteIdentMysql(dbName)}`,
        );
        const key = rows.length ? Object.keys(rows[0])[0] : null;
        if (!key) continue;
        for (const r of rows) {
          const t = String(r[key] || "");
          if (t.toLowerCase().includes(kw)) {
            if (matches.length >= limit) {
              truncated = true;
              break;
            }
            matches.push({ database: dbName, collection: t });
          }
        }
      } catch {
        // 跳过无权限的库
      }
    }

    matches.sort((a, b) => {
      const c = a.collection.localeCompare(b.collection);
      return c !== 0 ? c : a.database.localeCompare(b.database);
    });

    return { matches, truncated };
  }
}

function reviveForSql(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.__sql.date) return new Date(value.__sql.date);
    if (value.__sql.bigint) return BigInt(value.__sql.bigint);
    if (value.__sql.bytes) return Buffer.from(value.__sql.bytes, "hex");
  }
  return value;
}
