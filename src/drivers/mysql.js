// MySQL driver，基于 mysql2/promise
import mysql from "mysql2/promise";
import {
  validateWhere,
  validateOrderBy,
  parseLimit,
  quoteIdentMysql,
  normalizeRow,
  reviveForSql,
  assertIdent,
  validateSqlType,
  normalizeIndexKeys,
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

    // MariaDB 把 information_schema 列名返回为大写，MySQL 8 也是大写；统一用别名归一化
    const [statRows] = await this.pool.query(
      `SELECT
         data_length AS data_length,
         index_length AS index_length,
         data_free AS data_free
       FROM information_schema.tables
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

  async createTable(dbName, table, { columns = [] } = {}) {
    const database = assertIdent(dbName, "库名");
    const tableName = assertIdent(table, "表名");
    if (!Array.isArray(columns) || !columns.length) {
      throw new Error("至少需要一列");
    }
    let primaryCount = 0;
    const parts = columns.map((col) => {
      const name = quoteIdentMysql(assertIdent(col?.name, "列名"));
      const type = validateSqlType(col?.type);
      let part = `${name} ${type}`;
      if (col?.primary) {
        primaryCount += 1;
        part += " PRIMARY KEY";
      } else if (col?.notNull) {
        part += " NOT NULL";
      }
      return part;
    });
    if (primaryCount > 1) throw new Error("只能有一列 PRIMARY KEY");
    const sql = `CREATE TABLE ${quoteIdentMysql(database)}.${quoteIdentMysql(tableName)} (${parts.join(
      ", ",
    )})`;
    await this.pool.query(sql);
    return { name: tableName, sql };
  }

  async dropTable(dbName, table) {
    const database = assertIdent(dbName, "库名");
    const tableName = assertIdent(table, "表名");
    const sql = `DROP TABLE ${quoteIdentMysql(database)}.${quoteIdentMysql(tableName)}`;
    await this.pool.query(sql);
    return { name: tableName, sql };
  }

  async createIndex(dbName, table, { name, keys, unique = false } = {}) {
    const database = assertIdent(dbName, "库名");
    const tableName = assertIdent(table, "表名");
    const keyMap = normalizeIndexKeys(keys);
    const entries = Object.entries(keyMap);
    const cols = entries
      .map(([col, dir]) => `${quoteIdentMysql(col)} ${dir === -1 ? "DESC" : "ASC"}`)
      .join(", ");
    const idxName = name
      ? assertIdent(name, "索引名")
      : assertIdent(`${tableName}_${entries.map(([c]) => c).join("_")}_idx`, "索引名");
    const sql = `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdentMysql(idxName)} ON ${quoteIdentMysql(
      database,
    )}.${quoteIdentMysql(tableName)} (${cols})`;
    await this.pool.query(sql);
    return { name: idxName, sql };
  }

  async dropIndex(dbName, table, name) {
    const database = assertIdent(dbName, "库名");
    const tableName = assertIdent(table, "表名");
    const idxName = assertIdent(name, "索引名");
    const sql = `DROP INDEX ${quoteIdentMysql(idxName)} ON ${quoteIdentMysql(database)}.${quoteIdentMysql(
      tableName,
    )}`;
    await this.pool.query(sql);
    return { name: idxName, sql };
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
