// PostgreSQL driver，基于 pg
import pg from "pg";
import {
  validateWhere,
  validateOrderBy,
  parseLimit,
  quoteIdentPg,
  normalizeRow,
  reviveForSql,
  assertSingleStatement,
  assertIdent,
  validateSqlType,
  normalizeIndexKeys,
} from "./sql-base.js";

const SYSTEM_DBS = new Set(["template0", "template1", "postgres"]);

function buildPool(uri) {
  return new pg.Pool({
    connectionString: uri,
    max: 5,
    statement_timeout: 30000,
    query_timeout: 30000,
  });
}

export class PostgresDriver {
  constructor(uri) {
    this.type = "postgres";
    this.uri = uri;
    this.pool = null;
    this.dbName = "";
  }

  async connect() {
    this.pool = buildPool(this.uri);
    const client = await this.pool.connect();
    try {
      const res = await client.query("SELECT current_database() AS name");
      this.dbName = res.rows[0]?.name || "";
    } finally {
      client.release();
    }
  }

  async disconnect() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  client() {
    if (!this.pool) throw new Error("PostgreSQL 未连接");
    return this.pool;
  }

  async listDatabases() {
    const res = await this.pool.query(
      `SELECT datname AS name
       FROM pg_database
       WHERE NOT datistemplate
       ORDER BY datname`,
    );
    return res.rows
      .map((r) => r.name)
      .filter((n) => !SYSTEM_DBS.has(n))
      .map((name) => ({ name }));
  }

  async listTables(dbName) {
    const res = await this.pool.query(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    return res.rows.map((r) => ({ name: r.name }));
  }

  async query(dbName, table, { where = "", orderBy = "", limit = 20 } = {}) {
    const w = validateWhere(where);
    const ob = validateOrderBy(orderBy);
    const lim = parseLimit(limit);

    const tableIdent = `${quoteIdentPg("public")}.${quoteIdentPg(table)}`;
    const sql = `SELECT * FROM ${tableIdent}${w ? ` WHERE ${w}` : ""}${
      ob ? ` ORDER BY ${ob}` : ""
    } LIMIT ${lim}`;

    const res = await this.pool.query(sql);
    return { docs: res.rows.map(normalizeRow), sql };
  }

  async insert(dbName, table, doc) {
    const keys = Object.keys(doc);
    if (!keys.length) throw new Error("插入内容不能为空");
    const cols = keys.map(quoteIdentPg).join(", ");
    const values = keys.map((_, i) => `$${i + 1}`).join(", ");
    const params = keys.map((k) => reviveForSql(doc[k]));
    const sql = `INSERT INTO ${quoteIdentPg("public")}.${quoteIdentPg(
      table,
    )} (${cols}) VALUES (${values}) RETURNING *`;
    const res = await this.pool.query(sql, params);
    return { inserted: res.rowCount, returning: res.rows.map(normalizeRow) };
  }

  async update(dbName, table, { where = "", setDoc = {} } = {}) {
    const w = validateWhere(where);
    const keys = Object.keys(setDoc);
    if (!keys.length) throw new Error("SET 内容不能为空");
    const sets = keys.map((k, i) => `${quoteIdentPg(k)} = $${i + 1}`).join(", ");
    const params = keys.map((k) => reviveForSql(setDoc[k]));
    const sql = `UPDATE ${quoteIdentPg("public")}.${quoteIdentPg(
      table,
    )} SET ${sets}${w ? ` WHERE ${w}` : ""}`;
    const res = await this.pool.query(sql, params);
    return { updated: res.rowCount };
  }

  async delete(dbName, table, { where = "" } = {}) {
    const w = validateWhere(where);
    if (!w) throw new Error("DELETE 必须提供 WHERE 条件");
    const sql = `DELETE FROM ${quoteIdentPg("public")}.${quoteIdentPg(
      table,
    )} WHERE ${w}`;
    const res = await this.pool.query(sql);
    return { deleted: res.rowCount };
  }

  async stats(dbName, table) {
    const countRes = await this.pool.query(
      `SELECT count(*)::bigint AS c FROM ${quoteIdentPg("public")}.${quoteIdentPg(table)}`,
    );
    const count = Number(countRes.rows[0]?.c ?? 0);

    const statRes = await this.pool.query(
      `SELECT
         pg_total_relation_size(c.oid) AS total,
         pg_relation_size(c.oid) AS data_size,
         pg_indexes_size(c.oid) AS index_size
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`,
      [table],
    );
    const s = statRes.rows[0] || {};

    const idxRes = await this.pool.query(
      `SELECT count(*)::bigint AS c
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    );
    const indexCount = Number(idxRes.rows[0]?.c ?? 0);

    return {
      estimatedCount: count,
      accurateCount: count,
      size: Number(s.data_size ?? 0),
      storageSize: Number(s.total ?? 0),
      nIndexes: indexCount,
      avgObjSize: count > 0 ? Math.round(Number(s.data_size ?? 0) / count) : 0,
      totalIndexSize: Number(s.index_size ?? 0),
      freeStorageSize: null,
      indexSizes: {},
    };
  }

  async indexes(dbName, table) {
    const res = await this.pool.query(
      `SELECT indexname AS name, indexdef AS def
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = $1
       ORDER BY indexname`,
      [table],
    );
    return res.rows.map((r) => {
      const def = String(r.def || "");
      return {
        name: r.name,
        key: def,
        unique: /UNIQUE/i.test(def),
        sparse: false,
      };
    });
  }

  async createTable(dbName, table, { columns = [] } = {}) {
    const tableName = assertIdent(table, "表名");
    if (!Array.isArray(columns) || !columns.length) {
      throw new Error("至少需要一列");
    }
    let primaryCount = 0;
    const parts = columns.map((col) => {
      const name = quoteIdentPg(assertIdent(col?.name, "列名"));
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
    const sql = `CREATE TABLE ${quoteIdentPg("public")}.${quoteIdentPg(tableName)} (${parts.join(", ")})`;
    await this.pool.query(sql);
    return { name: tableName, sql };
  }

  async dropTable(dbName, table) {
    const tableName = assertIdent(table, "表名");
    const sql = `DROP TABLE ${quoteIdentPg("public")}.${quoteIdentPg(tableName)}`;
    await this.pool.query(sql);
    return { name: tableName, sql };
  }

  async createIndex(dbName, table, { name, keys, unique = false } = {}) {
    const tableName = assertIdent(table, "表名");
    const keyMap = normalizeIndexKeys(keys);
    const entries = Object.entries(keyMap);
    const cols = entries
      .map(([col, dir]) => `${quoteIdentPg(col)} ${dir === -1 ? "DESC" : "ASC"}`)
      .join(", ");
    const idxName = name
      ? assertIdent(name, "索引名")
      : assertIdent(`${tableName}_${entries.map(([c]) => c).join("_")}_idx`, "索引名");
    const sql = `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdentPg(idxName)} ON ${quoteIdentPg(
      "public",
    )}.${quoteIdentPg(tableName)} (${cols})`;
    await this.pool.query(sql);
    return { name: idxName, sql };
  }

  async dropIndex(dbName, table, name) {
    const idxName = assertIdent(name, "索引名");
    const sql = `DROP INDEX ${quoteIdentPg("public")}.${quoteIdentPg(idxName)}`;
    await this.pool.query(sql);
    return { name: idxName, sql };
  }

  async runCommand(text) {
    const trimmed = assertSingleStatement(String(text || ""));
    if (!trimmed) throw new Error("SQL 不能为空");
    const res = await this.pool.query(trimmed);
    if (res.rows && res.rows.length) {
      return {
        resultType: "rows",
        docs: res.rows.map(normalizeRow),
        rowCount: res.rowCount,
        fields: res.fields.map((f) => f.name),
      };
    }
    return {
      resultType: "exec",
      rowCount: res.rowCount,
      message: `影响的行数: ${res.rowCount}`,
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
        const conn = `${this.uri.replace(/\/[^/]*$/, "")}/${dbName}`;
        const tmp = new pg.Pool({
          connectionString: conn,
          max: 2,
          statement_timeout: 5000,
          query_timeout: 5000,
        });
        try {
          const res = await tmp.query(
            `SELECT table_name AS name
             FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
               AND LOWER(table_name) LIKE '%' || $1 || '%'
             ORDER BY table_name`,
            [kw],
          );
          for (const row of res.rows) {
            if (matches.length >= limit) {
              truncated = true;
              break;
            }
            matches.push({ database: dbName, collection: row.name });
          }
        } finally {
          await tmp.end();
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
