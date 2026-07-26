# MongoX API 设计文档

> **版本**：v1.0  ·  **最后更新**：2026-07-26  ·  **后端入口**：`src/server.js`
> **适用驱动**：MongoDB / PostgreSQL / MySQL（同一套接口，按 `connection.type` 路由）

---

## 目录

- [1. 概览](#1-概览)
- [2. 通用约定](#2-通用约定)
- [3. 数据模型](#3-数据模型)
- [4. 鉴权 API](#4-鉴权-api)
- [5. 会话与连接查询 API](#5-会话与连接查询-api)
- [6. 连接管理 API](#6-连接管理-api)
- [7. 数据库 / 集合导航 API](#7-数据库--集合导航-api)
- [8. 数据操作 API（CRUD）](#8-数据操作-apicrud)
- [9. 元数据 API（统计 / 索引）](#9-元数据-api统计--索引)
- [10. 导出 API](#10-导出-api)
- [11. 错误码对照表](#11-错误码对照表)
- [12. 附录](#12-附录)

---

## 1. 概览

### 1.1 Base URL

| 环境       | Base URL                              |
| ---------- | ------------------------------------- |
| 本地开发   | `http://localhost:5000`               |
| 生产部署   | `https://mongo.haoaiganfan.top`       |

所有 API 统一前缀 `/mongo/api`，下文每个接口的"路径"列都是相对此前缀。

### 1.2 服务启动检查

服务启动时若未设置 `MONGOX_PASSWORD` 环境变量，进程会直接 `process.exit(1)`，所有请求都会失败。这是登录密码的 HMAC 密钥。

### 1.3 接口总览

| #   | 方法   | 路径                                | 用途                          | 鉴权 |
| --- | ------ | ----------------------------------- | ----------------------------- | ---- |
| 1   | GET    | `/mongo/api/health`                 | 健康检查（含会话状态）         | 否   |
| 2   | POST   | `/mongo/api/login`                  | 密码登录，下发 auth cookie    | 否   |
| 3   | POST   | `/mongo/api/logout`                 | 注销                           | 是   |
| 4   | GET    | `/mongo/api/status`                 | 查询当前会话状态               | 是   |
| 5   | GET    | `/mongo/api/connections`            | 列出全部已保存的连接           | 是   |
| 6   | POST   | `/mongo/api/connections`            | 创建或更新连接配置             | 是   |
| 7   | POST   | `/mongo/api/connections/:id/select` | 切换活跃连接（不发起真实连接） | 是   |
| 8   | POST   | `/mongo/api/connections/:id/connect`| 真实建立连接                   | 是   |
| 9   | POST   | `/mongo/api/connections/:id/disconnect` | 断开活跃连接池             | 是   |
| 10  | DELETE | `/mongo/api/connections/:id`        | 删除连接配置                   | 是   |
| 11  | POST   | `/mongo/api/connect`                | 旧版兼容：URI 直连             | 是   |
| 12  | POST   | `/mongo/api/disconnect`             | 旧版兼容：断开活跃连接         | 是   |
| 13  | GET    | `/mongo/api/databases`              | 列出全部数据库                 | 是   |
| 14  | POST   | `/mongo/api/database`               | 选择数据库                     | 是   |
| 15  | GET    | `/mongo/api/collections`            | 列出当前库的集合 / 表          | 是   |
| 15a | POST   | `/mongo/api/collections`            | 创建集合 / 表                   | 是   |
| 15b | DELETE | `/mongo/api/collections`            | 删除集合 / 表                   | 是   |
| 16  | GET    | `/mongo/api/search-collections`     | 跨库搜索集合 / 表              | 是   |
| 17  | POST   | `/mongo/api/collection`             | 选择集合 / 表                  | 是   |
| 18  | POST   | `/mongo/api/command`                | 终端命令（Shell 或 SQL）       | 是   |
| 19  | POST   | `/mongo/api/query`                  | 查询文档 / 行                  | 是   |
| 20  | POST   | `/mongo/api/insert`                 | 插入                           | 是   |
| 21  | POST   | `/mongo/api/update`                 | 更新                           | 是   |
| 22  | POST   | `/mongo/api/delete`                 | 删除                           | 是   |
| 23  | GET    | `/mongo/api/stats`                  | 集合统计（仅 Mongo）           | 是   |
| 24  | GET    | `/mongo/api/indexes`                | 列出索引                       | 是   |
| 24a | POST   | `/mongo/api/indexes`                | 创建索引                       | 是   |
| 24b | DELETE | `/mongo/api/indexes`                | 删除索引                       | 是   |
| 25  | GET    | `/mongo/api/collection-stats`       | 集合 / 表详细统计              | 是   |
| 26  | POST   | `/mongo/api/export`                 | 导出（仅 Mongo）               | 是   |

---

## 2. 通用约定

### 2.1 鉴权机制

服务端用 **HMAC-SHA256 签名的 HttpOnly cookie** 做会话鉴权：

| Cookie 名            | 作用                                      | 有效期 |
| -------------------- | ----------------------------------------- | ------ |
| `mongox_auth`        | 登录凭证（payload + HMAC 签名）           | 7 天   |
| `mongox_client_id`   | 客户端标识，用于隔离不同浏览器/tab 的数据 | 1 年   |

- **未登录访问** HTML 页面 → `302` 重定向到 `/login`
- **未登录访问** `/mongo/api/*`（除 `/login`、`/health`）→ `401 { ok: false, error: "未登录或会话已过期" }`

### 2.2 客户端隔离（clientId）

每个请求都会带 `clientId`（从 cookie 读取；缺失时自动生成并 Set-Cookie）。所有连接配置、活跃连接、运行时池均按 `clientId` 隔离，互不串扰。

### 2.3 请求格式

- `Content-Type: application/json`（除导出接口外）
- body 上限 `2mb`

### 2.4 响应格式

#### 成功

```json
{ "ok": true, "...其余字段": "..." }
```

#### 失败

```json
{ "ok": false, "error": "中文错误描述" }
```

部分 mongo 自适应重试失败的请求会附带 `triedVariants` 字段（详见 [§11](#11-错误码对照表)）。

### 2.5 路径参数

| 字段 | 位置 | 说明 |
| ---- | ---- | ---- |
| `:id` | URL | 连接记录的主键（UUID v4），由后端在创建连接时生成 |

### 2.6 驱动类型

`type` 字段枚举：

| 值         | 驱动实现                  |
| ---------- | ------------------------- |
| `mongo`    | `mongodb` + `bson` (EJSON)|
| `postgres` | `pg`                      |
| `mysql`    | `mysql2`                  |

---

## 3. 数据模型

### 3.1 Connection（连接记录，落盘到 `data/connections.json`）

```ts
interface Connection {
  id: string;               // UUID v4
  name: string;             // 显示名（如 "PG @ 127.0.0.1:5432"）
  type: "mongo" | "postgres" | "mysql";
  uri: string;              // 完整连接串（含密码）
  dbName: string;           // 当前选中的库（可空）
  collectionName: string;   // 当前选中的集合/表（可空）
  createdAt: string;        // ISO 时间
  updatedAt: string;        // ISO 时间
  lastUsedAt: string | null;
  lastConnectedAt: string | null;
}
```

### 3.2 ConnectionSummary（对外的脱敏视图）

```ts
interface ConnectionSummary {
  id: string;
  name: string;
  type: "mongo" | "postgres" | "mysql";
  uri: string;              // 原始 URI（用于前端展示完整串）
  uriMasked: string;        // 脱敏后的 URI（password → ****）
  dbName: string;
  collectionName: string;
  connected: boolean;       // 是否已建立运行时连接
  isActive: boolean;        // 是否为当前活跃连接
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  lastConnectedAt: string | null;
}
```

### 3.3 Status（会话状态）

```ts
interface Status {
  connected: boolean;
  driverType: "mongo" | "postgres" | "mysql";
  activeConnectionId: string | null;
  connectionName: string;
  uri: string;
  uriMasked: string;
  dbName: string;
  collectionName: string;
}
```

### 3.4 Stats（集合/表统计）

Mongo（来自 `collStats`）：

```ts
interface MongoStats {
  estimatedCount: number;
  accurateCount: number;
  size: number | null;
  storageSize: number | null;
  nIndexes: number | null;
  avgObjSize: number | null;
  totalIndexSize: number | null;
  freeStorageSize: number | null;
  capped: boolean | null;
  indexSizes: Record<string, number>;
}
```

SQL（PG/MySQL 统一字段，见 [§9.3](#93-get-collectionstats)）：

```ts
interface SqlStats {
  estimatedCount: number;
  accurateCount: number;
  size: number;             // 数据大小（字节）
  storageSize: number;      // 含索引的总占用
  nIndexes: number | null;  // PG: 实际数量；MySQL: null
  avgObjSize: number;
  totalIndexSize: number;
  freeStorageSize: number | null;  // PG: null
  indexSizes: Record<string, number>; // PG/MySQL 均为 {}
}
```

### 3.5 Index

```ts
interface Index {
  name: string;
  key: Record<string, 1 | -1> | string;  // Mongo/MySQL 为对象；PG 为 CREATE INDEX 原文
  unique: boolean;
  sparse: boolean;                        // PG/MySQL 始终 false
}
```

### 3.6 MatchedTable（跨库搜索结果）

```ts
interface MatchedTable {
  database: string;
  collection: string;     // SQL 表名也复用此字段
}
```

---

## 4. 鉴权 API

### 4.1 POST `/mongo/api/login`

**用途**：密码登录，成功后下发 `mongox_auth` cookie。

**是否需登录**：否

**请求体**：

```json
{ "password": "string" }
```

| 字段       | 类型   | 必填 | 说明                          |
| ---------- | ------ | ---- | ----------------------------- |
| `password` | string | 是   | 明文密码，与服务端 `MONGOX_PASSWORD` 比较 |

**响应**（200）：

```json
{ "ok": true }
```

`Set-Cookie: mongox_auth=<expireAt>.<hmac>; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax`

**错误**：

| 状态码 | 触发条件                       | 响应体                                   |
| ------ | ------------------------------ | ---------------------------------------- |
| 400    | 密码缺失                       | `{ ok: false, error: "请输入密码" }`     |
| 401    | 密码错误                       | `{ ok: false, error: "密码错误" }`       |
| 500    | 服务端未配置 `MONGOX_PASSWORD` | `{ ok: false, error: "服务端未配置密码" }`|

### 4.2 POST `/mongo/api/logout`

**用途**：注销，清空 auth cookie（不释放连接池）。

**是否需登录**：是

**请求体**：空

**响应**（200）：

```json
{ "ok": true }
```

`Set-Cookie: mongox_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`

### 4.3 GET `/mongo/api/health`

**用途**：健康检查，附带当前会话状态（无需登录也能调，便于前端引导）。

**是否需登录**：否

**响应**（200）：

```json
{
  "ok": true,
  "status": { /* 见 §3.3 Status */ }
}
```

---

## 5. 会话与连接查询 API

### 5.1 GET `/mongo/api/status`

**用途**：查询当前活跃连接的状态。

**是否需登录**：是

**响应**（200）：

```json
{
  "ok": true,
  "status": {
    "connected": true,
    "driverType": "postgres",
    "activeConnectionId": "ff8ba689-7f1f-42e1-8656-a088f0729677",
    "connectionName": "PG @ 127.0.0.1:5432",
    "uri": "postgresql://mongox_test:testpass123@127.0.0.1:5432/mongox_testdb",
    "uriMasked": "postgresql://mongox_test:****@127.0.0.1:5432/mongox_testdb",
    "dbName": "mongox_testdb",
    "collectionName": "users"
  }
}
```

未选择活跃连接时返回 `connected: false`、`activeConnectionId: null`、所有字符串字段为空。

### 5.2 GET `/mongo/api/connections`

**用途**：列出当前客户端所有已保存的连接记录，按 `lastUsedAt || updatedAt || createdAt` 倒序。

**是否需登录**：是

**响应**（200）：

```json
{
  "ok": true,
  "activeConnectionId": "ff8ba689-7f1f-42e1-8656-a088f0729677",
  "status": { /* 见 §3.3 Status */ },
  "connections": [
    { /* 见 §3.2 ConnectionSummary */ },
    { /* ... */ }
  ]
}
```

---

## 6. 连接管理 API

### 6.1 POST `/mongo/api/connections`

**用途**：新建或更新连接配置（按 `id` 或 `uri` 去重）。新建后会自动设为活跃，但**不会真实建立连接**——需再调 [§6.3 connect](#63-post-connectionsidconnect)。

**是否需登录**：是

**请求体**：

```json
{
  "id": "string | null",       // 可选。提供则更新，否则按 uri 去重
  "name": "string",            // 可选。缺省由 uri 推导（如 "Mongo @ host:port"）
  "type": "mongo | postgres | mysql",  // 缺省 mongo
  "uri": "string"              // 必填
}
```

| 字段   | 类型            | 必填 | 缺省/说明                                  |
| ------ | --------------- | ---- | ------------------------------------------ |
| `uri`  | string          | 是   | 完整连接串                                 |
| `type` | enum            | 否   | `mongo`                                    |
| `id`   | string (UUID)   | 否   | 提供 → 按 id 找现有记录更新                |
| `name` | string          | 否   | 推断格式：`{PG\|MySQL\|Mongo} @ {host}`    |

**响应**（200）：

```json
{
  "ok": true,
  "status": { /* 见 §3.3 Status */ },
  "connection": { /* 见 §3.2 ConnectionSummary，新活跃连接 */ },
  "activeConnectionId": "uuid"
}
```

**错误**：

| 状态码 | 触发条件         | 响应体                                       |
| ------ | ---------------- | -------------------------------------------- |
| 400    | `uri` 为空       | `{ ok: false, error: "连接字符串不能为空" }` |

### 6.2 POST `/mongo/api/connections/:id/select`

**用途**：把 `:id` 设为活跃连接，但**不发起真实连接**，也不发任何 ping。仅更新 `lastUsedAt`。后续业务请求首次用到时才会懒连接。

**是否需登录**：是

**路径参数**：

| 字段 | 类型   | 必填 | 说明        |
| ---- | ------ | ---- | ----------- |
| `id` | string | 是   | 连接记录 id |

**请求体**：空

**响应**（200）：

```json
{
  "ok": true,
  "status": { /* 见 §3.3 Status */ },
  "connection": { /* 见 §3.2 ConnectionSummary */ }
}
```

**错误**：

| 状态码 | 触发条件        | 响应体                                       |
| ------ | --------------- | -------------------------------------------- |
| 404    | 找不到该连接 id | `{ ok: false, error: "连接配置不存在" }`     |

### 6.3 POST `/mongo/api/connections/:id/connect`

**用途**：对 `:id` 真实建立连接（含 mongo 自适应重试）。

**是否需登录**：是

**请求体**：空

**响应**（200）：

```json
{
  "ok": true,
  "status": { /* 见 §3.3 Status */ },
  "connection": { /* 见 §3.2 ConnectionSummary */ },
  "adapted": false,
  "adaptationReason": null
}
```

| 字段               | 类型           | 说明                                                                 |
| ------------------ | -------------- | -------------------------------------------------------------------- |
| `adapted`          | boolean        | 是否使用了降级重试（如 `directConnection=true` 或 `authSource` 切换） |
| `adaptationReason` | string \| null | 降级原因（中文），仅在 `adapted: true` 时返回                        |

**mongo 自适应重试规则**：

1. 先用原始 URI 试连（6s 超时）
2. 失败后按顺序尝试：
   - `?directConnection=true`
   - 当前 `authSource` / 库名 / `admin` × 当前 `authMechanism` / `SCRAM-SHA-1` / `SCRAM-SHA-256`
3. 仍失败 → 抛 502，附带 `triedVariants` 数组

**错误**：详见 [§11](#11-错误码对照表)。

### 6.4 POST `/mongo/api/connections/:id/disconnect`

**用途**：关闭该连接的运行时（mongo client 或 SQL pool）。

**是否需登录**：是

**请求体**：空

**响应**（200）：

```json
{
  "ok": true,
  "status": { /* 见 §3.3 Status */ },
  "connection": { /* 见 §3.2 ConnectionSummary */ }
}
```

### 6.5 DELETE `/mongo/api/connections/:id`

**用途**：永久删除该连接配置，并先关闭其运行时。删除活跃连接时，`activeConnectionId` 自动指向剩余列表中的第一个（或 `null`）。

**是否需登录**：是

**响应**（200）：

```json
{
  "ok": true,
  "status": { /* 见 §3.3 Status */ },
  "activeConnectionId": "uuid | null",
  "connections": [ /* 见 §3.2 ConnectionSummary，剩余的全部连接 */ ]
}
```

**错误**：

| 状态码 | 触发条件        | 响应体                                       |
| ------ | --------------- | -------------------------------------------- |
| 404    | 找不到该连接 id | `{ ok: false, error: "连接配置不存在" }`     |

### 6.6 POST `/mongo/api/connect`

**用途**：旧版兼容接口。直接传 `uri` 立即建连，等价于「创建 + 设为活跃 + connect」三合一。新前端建议用 [§6.1](#61-post-mongoapiconnections) + [§6.3](#63-post-connectionsidconnect)。

**是否需登录**：是

**请求体**：

```json
{
  "uri": "string",            // 必填
  "type": "mongo | postgres | mysql",  // 缺省 mongo
  "name": "string"            // 可选
}
```

**响应**（200）：

```json
{
  "ok": true,
  "status": { /* 见 §3.3 Status */ },
  "adapted": false,
  "adaptationReason": null,
  "activeConnectionId": "uuid"
}
```

**错误**：详见 [§11](#11-错误码对照表)。

### 6.7 POST `/mongo/api/disconnect`

**用途**：旧版兼容接口。断开**当前活跃**连接的运行时（不删除记录）。

**是否需登录**：是

**请求体**：空

**响应**（200）：

```json
{ "ok": true, "status": { /* 见 §3.3 Status */ } }
```

---

## 7. 数据库 / 集合导航 API

> 本组接口都要求**已存在活跃连接**；首次调用会自动触发懒连接（含 mongo 自适应重试）。

### 7.1 GET `/mongo/api/databases`

**用途**：列出当前连接下所有可访问的数据库。

**是否需登录**：是

**请求参数**：无

**响应**（200）：

```json
{
  "ok": true,
  "databases": [
    { "name": "mongox_testdb", "sizeOnDisk": null }
  ],
  "warning": null
}
```

| 字段         | 类型                    | 说明                                                                       |
| ------------ | ----------------------- | -------------------------------------------------------------------------- |
| `databases`  | `{ name, sizeOnDisk }[]`| 按名字升序；SQL 系 `sizeOnDisk` 始终为 `null`，mongo 来自 `listDatabases`  |
| `warning`    | string \| null          | 列举失败时返回中文原因（数据库仍会返回 `[]`，状态码仍为 200）              |

**自动副作用**：若当前 `dbName` 为空且列表非空，自动写入 `databases[0].name` 并持久化。

**驱动差异**：

| 驱动     | 列举方式                                                              | 过滤系统库                                       |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| Mongo    | `db.admin().listDatabases({ nameOnly: true })`                        | 无（admin/local/config 由前端过滤可选）          |
| Postgres | `SELECT datname FROM pg_database WHERE NOT datistemplate`             | `template0`、`template1`、`postgres`             |
| MySQL    | `SHOW DATABASES`                                                      | `information_schema`、`performance_schema`、`mysql`、`sys` |

### 7.2 POST `/mongo/api/database`

**用途**：选择当前数据库，顺带返回该库下的集合/表名列表。

**是否需登录**：是

**请求体**：

```json
{ "dbName": "string" }   // 必填
```

**响应**（200）：

```json
{
  "ok": true,
  "status": { /* 见 §3.3 Status，dbName 已更新 */ },
  "collections": ["users", "orders"],
  "warning": null
}
```

| 字段          | 类型             | 说明                                                            |
| ------------- | ---------------- | --------------------------------------------------------------- |
| `collections` | string[]         | 集合/表名列表（按字典序）；SQL 也复用此字段名                   |
| `warning`     | string \| null   | 列举失败时给出原因，前端可让用户手动输入                        |

**副作用**：写入 `connection.dbName`、清空 `collectionName`、更新 `updatedAt`。

### 7.3 GET `/mongo/api/collections`

**用途**：列出**当前数据库**下的全部集合 / 表。

**前置条件**：已选择数据库（否则 400）。

**是否需登录**：是

**响应**（200）：

```json
{
  "ok": true,
  "collections": ["users", "orders"],
  "warning": null
}
```

**驱动差异**：

| 驱动     | 实现                                                                                |
| -------- | ----------------------------------------------------------------------------------- |
| Mongo    | `db.listCollections().toArray()`                                                    |
| Postgres | `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'` |
| MySQL    | `SHOW TABLES FROM \`db\``                                                           |

### 7.4 GET `/mongo/api/search-collections`

**用途**：跨**所有**数据库搜索名称包含关键字的集合/表（不区分大小写）。

**前置条件**：已选择数据库（否则 400）。

**请求参数**（query string）：

| 字段     | 类型   | 必填 | 说明                                |
| -------- | ------ | ---- | ----------------------------------- |
| `keyword`| string | 是   | 关键字，空字符串返回空结果          |
| `limit`  | number | 否   | mongo 默认 100，最大 200；SQL 固定 100 |

**响应**（200）：

```json
{
  "ok": true,
  "matches": [
    { "database": "mongox_testdb", "collection": "users" }
  ],
  "truncated": false
}
```

| 字段        | 类型                          | 说明                          |
| ----------- | ----------------------------- | ----------------------------- |
| `matches`   | `MatchedTable[]`              | 见 §3.6                       |
| `truncated` | boolean                       | 是否因达到 limit 而截断       |

**驱动差异**：

| 驱动     | 实现                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| Mongo    | 遍历非系统库（admin/local/config）的 `listCollections`，内存 substring 过滤      |
| Postgres | 遍历每个库建临时 `pg.Pool` 跑 `WHERE table_name LIKE '%kw%'`（5s 超时）          |
| MySQL    | 遍历每个库 `SHOW TABLES FROM`，内存过滤；跳过无权限库                            |

### 7.5 POST `/mongo/api/collection`

**用途**：选择当前集合 / 表。

**前置条件**：已选择数据库。

**是否需登录**：是

**请求体**：

```json
{ "collectionName": "string" }  // 必填
```

**响应**（200）：

```json
{ "ok": true, "status": { /* 见 §3.3 Status，collectionName 已更新 */ } }
```

---

## 8. 数据操作 API（CRUD）

> 所有 CRUD 接口的请求/响应**按驱动类型分支**，下方每个接口都会标注差异。

### 8.1 POST `/mongo/api/query`

**用途**：查询文档 / 行。

**前置条件**：已选择数据库 + 集合 / 表。

#### Mongo 请求体

```json
{
  "filter": "{}",            // EJSON 字符串或对象；缺省 {}
  "projection": "{_id: 1}",  // 可选
  "sort": "{createdAt: -1}", // 可选
  "limit": 20                // 缺省 20，最大 500
}
```

#### SQL 请求体

```json
{
  "where": "id > 100 AND status = 'active'",  // SQL WHERE 片段，白名单校验
  "orderBy": "created_at DESC",               // ORDER BY 片段
  "limit": 20                                 // 缺省 20
}
```

> SQL 也兼容字段别名：`filter` ↔ `where`、`sort` ↔ `orderBy`。

#### Mongo 响应（200）

```json
{
  "ok": true,
  "count": 2,
  "docs": [
    { "_id": { "$oid": "65f..." }, "name": "Alice" }
  ]
}
```

`docs` 为 EJSON 序列化结果（保留 `$date` / `$oid` 等扩展类型）。

#### SQL 响应（200）

```json
{
  "ok": true,
  "count": 2,
  "docs": [ { "id": 1, "name": "Alice" } ],
  "sql": "SELECT * FROM \"public\".\"users\" WHERE id > 100 ORDER BY created_at DESC LIMIT 20"
}
```

**SQL WHERE 白名单**：禁止包含 `;` `--` `/* */`，仅允许标识符、数字、字符串字面量、操作符。详见 `src/drivers/sql-base.js::validateWhere`。

### 8.2 POST `/mongo/api/command`

**用途**：终端命令。Mongo 走 `db.coll.method()` 解析器；SQL 走原始 SQL（强制单语句）。

**前置条件**：已选择数据库。

#### 请求体

```json
{ "command": "string" }
```

#### Mongo 命令语法

支持的根方法：

- `find(filter, projection, options)` + 链式 `.sort/.project/.limit/.skip/.toArray`
- `findOne(filter, projection)`
- `countDocuments(filter)`
- `insertOne(doc)` / `insertMany(docs)`
- `updateOne/updateMany(filter, update, options)`
- `deleteOne/deleteMany(filter)`

支持 `db.<collection>.method()` 与 `db.getCollection("<name>").method()` 两种写法；链式调用仅支持 `sort/project/limit/skip/toArray`。

#### SQL 命令

- 单条 SQL，**禁止多语句**（`src/drivers/sql-base.js::assertSingleStatement` 会扫描整个 SQL 字符流，识别字符串 / 注释 / 美元引用，遇到 `;` 后还有内容即报错）
- PG 端额外限制：`statement_timeout = 30s`、`query_timeout = 30s`
- MySQL 端：`connectTimeout = 10s`、`multipleStatements: false`

#### 响应（200）

`resultType` 字段区分返回形态：

```json
// find / 普通 SELECT
{
  "ok": true,
  "status": { /* §3.3 */ },
  "command": "原始命令",
  "resultType": "find | rows",
  "count": 2,
  "limit": 50,
  "skip": 0,
  "docs": [ /* EJSON（mongo）或纯 JSON（SQL）*/ ],
  "rowCount": 2,         // SQL 才有
  "fields": ["id", "name"],  // SQL 才有
  "elapsedMs": 12        // mongo find/findOne/countDocuments/insert/update/delete 才有
}

// findOne
{ "ok": true, "resultType": "findOne", "doc": { /* ... */ } | null, "found": true }

// countDocuments
{ "ok": true, "resultType": "countDocuments", "count": 42, "elapsedMs": 3 }

// insertOne
{ "ok": true, "resultType": "insertOne", "insertedId": { "$oid": "..." }, "elapsedMs": 8 }

// insertMany
{ "ok": true, "resultType": "insertMany", "insertedCount": 3, "insertedIds": [ /* ... */ ], "elapsedMs": 9 }

// updateOne / updateMany
{
  "ok": true,
  "resultType": "updateOne",
  "matchedCount": 1, "modifiedCount": 1, "upsertedCount": 0,
  "elapsedMs": 5
}

// deleteOne / deleteMany
{ "ok": true, "resultType": "deleteOne", "deletedCount": 1, "elapsedMs": 4 }

// SQL 写操作（INSERT/UPDATE/DELETE 等）
{ "ok": true, "resultType": "exec", "rowCount": 1, "message": "影响的行数: 1" }
```

### 8.3 POST `/mongo/api/insert`

**前置条件**：已选择数据库 + 集合。

#### Mongo 请求体

```json
{ "doc": "{ name: 'Alice', age: 30 }" }  // EJSON 字符串或对象
```

#### Mongo 响应（200）

```json
{ "ok": true, "insertedId": { "$oid": "65f..." } }
```

#### SQL 请求体

```json
{
  "doc": { "name": "Alice", "age": 30 },
  // 或带类型标记：
  "doc": {
    "name": "Alice",
    "created_at": { "__sql": { "date": "2026-07-26T00:00:00.000Z" } },
    "balance": { "__sql": { "bigint": "9999999999" } },
    "avatar": { "__sql": { "bytes": "deadbeef" } }
  }
}
```

字段值支持三种 SQL 类型提示：`__sql.date`（ISO）、`__sql.bigint`（字符串）、`__sql.bytes`（hex）。普通值原样参数化绑定。

#### SQL 响应（200）

```json
{
  "ok": true,
  "inserted": 1,
  "returning": [ /* PG 用 RETURNING * 返回新行；MySQL 为空数组 */ ]
}
```

### 8.4 POST `/mongo/api/update`

**前置条件**：已选择数据库 + 集合。

#### Mongo 请求体

```json
{
  "filter": "{_id:{$oid:'...'}}",     // EJSON
  "update": "{$set:{age:31}}",        // EJSON；若无 $ 操作符，自动包成 $set
  "many": false,
  "upsert": false
}
```

#### Mongo 响应（200）

```json
{
  "ok": true,
  "matchedCount": 1,
  "modifiedCount": 1,
  "upsertedCount": 0
}
```

#### SQL 请求体

```json
{
  "where": "id = 1",
  "setDoc": { "age": 31 }            // 也支持字段别名 update；支持 __sql 类型标记
}
```

#### SQL 响应（200）

```json
{ "ok": true, "updated": 1 }        // 影响行数
```

### 8.5 POST `/mongo/api/delete`

**前置条件**：已选择数据库 + 集合。

#### Mongo 请求体

```json
{ "filter": "{_id:{$oid:'...'}}", "many": false }
```

#### Mongo 响应（200）

```json
{ "ok": true, "deletedCount": 1 }
```

#### SQL 请求体

```json
{ "where": "id = 1" }
```

> SQL 端**强制要求** `where` 非空（防止全表删除），否则 400。

#### SQL 响应（200）

```json
{ "ok": true, "deleted": 1 }
```

---

## 9. 元数据 API（统计 / 索引）

### 9.1 GET `/mongo/api/stats`

> **仅 Mongo 适用**。SQL 模式前端不调此接口（调 [§9.3](#93-get-collectionstats) 替代）。

**前置条件**：已选择数据库 + 集合。

**响应**（200）：

```json
{
  "ok": true,
  "stats": {
    "estimatedCount": 1234,
    "accurateCount": 1234,
    "indexCount": 2,
    "storageSize": 69632,
    "avgObjSize": 56,
    "totalIndexSize": 53248
  }
}
```

### 9.2 GET `/mongo/api/indexes`

**用途**：列出指定集合/表的索引。

**前置条件**：已选择数据库。

**请求参数**（query string）：

| 字段              | 类型   | 必填 | 说明                      |
| ----------------- | ------ | ---- | ------------------------- |
| `dbName`          | string | 否   | 缺省取 `connection.dbName`|
| `collectionName`  | string | 是   | 集合 / 表名               |

**响应**（200）：

```json
{
  "ok": true,
  "indexes": [
    {
      "name": "_id_",
      "key": { "_id": 1 },
      "unique": true,
      "sparse": false
    }
  ]
}
```

**驱动差异**：

| 驱动     | 实现                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| Mongo    | `db.collection.indexes()`                                                         |
| Postgres | `pg_indexes`，`key` 字段返回 `CREATE INDEX` 原文（如 `CREATE UNIQUE INDEX ...`)   |
| MySQL    | `SHOW INDEX FROM`，按 `Key_name` 分组，`key` 为 `{ Column: 1 \| -1 }`             |

### 9.3 GET `/mongo/api/collection-stats`

**用途**：详细统计。SQL 端字段统一。

**前置条件**：已选择数据库。

**请求参数**（query string）：同 [§9.2](#92-get-mongoapiindexes)。

**响应**（200）：

```json
// Mongo
{
  "ok": true,
  "stats": {
    "estimatedCount": 1234,
    "accurateCount": 1234,
    "size": 69632,
    "storageSize": 69632,
    "nIndexes": 2,
    "avgObjSize": 56,
    "totalIndexSize": 53248,
    "freeStorageSize": 0,
    "capped": false,
    "indexSizes": { "_id_": 24576, "name_1": 28672 }
  }
}

// Postgres / MySQL（字段统一）
{
  "ok": true,
  "stats": {
    "estimatedCount": 1234,
    "accurateCount": 1234,
    "size": 69632,                 // PG: pg_relation_size；MySQL: data_length
    "storageSize": 122880,         // PG: pg_total_relation_size；MySQL: data+index
    "nIndexes": 2,                 // PG: pg_indexes 数；MySQL: null
    "avgObjSize": 56,              // size / count
    "totalIndexSize": 53248,
    "freeStorageSize": null,       // PG: null；MySQL: data_free
    "indexSizes": {}               // SQL 始终为 {}
  }
}
```

---

## 10. 导出 API

### 10.1 POST `/mongo/api/export`

> **仅 Mongo 适用**。SQL 模式无导出接口。

**前置条件**：已选择数据库 + 集合。

**请求体**：

```json
{
  "filter": "{}",            // 可选
  "projection": "{}",        // 可选
  "sort": "{}",              // 可选
  "format": "json | yaml | csv | ndjson",  // 缺省 json
  "limit": 100               // 缺省 100，最大 5000
}
```

**响应**：文件下载（不是 JSON）。

| Header              | 值                                                              |
| ------------------- | --------------------------------------------------------------- |
| `Content-Type`      | 按 format 切换（见下）                                          |
| `Content-Disposition`| `attachment; filename="<db>_<coll>_<ts>.<ext>"`                |

| format   | Content-Type                              | 序列化方式                                  |
| -------- | ----------------------------------------- | ------------------------------------------- |
| `json`   | `application/json; charset=utf-8`         | `EJSON.stringify({ relaxed:false, indent:2 })` |
| `yaml`   | `application/x-yaml; charset=utf-8`       | relaxed EJSON → JSON → `yaml.dump`          |
| `csv`    | `text/csv; charset=utf-8`                 | 字段合集作表头，EJSON 序列化每个值          |
| `ndjson` | `application/x-ndjson; charset=utf-8`     | 每行一条 relaxed:false EJSON                |

---

## 11. 错误码对照表

### 11.1 全局错误中间件

所有未捕获的异常会经过统一中间件：

```js
{
  ok: false,
  error: "<中文友好消息>",
  triedVariants?: [ /* mongo 自适应重试失败时附带 */ ]
}
```

### 11.2 状态码分类规则

| 状态码 | 触发条件                                                                          |
| ------ | --------------------------------------------------------------------------------- |
| 400    | 请求参数缺失 / 集合未选择 / SQL 语法错 / 关系/表不存在 / `ECONNREFUSED` / `ENOTFOUND` / 连接超时 / 数据库不存在 |
| 401    | 未登录或会话过期；登录密码错误；运行时认证失败（`authentication failed` / `access denied` / `password authentication failed`） |
| 404    | 路径参数 `:id` 在持久化存储中找不到                                               |
| 500    | 其他未分类错误                                                                    |
| 502    | mongo 自适应重试全部失败（`error.statusCode = 502`，详见 [§6.3](#63-post-connectionsidconnect)） |

### 11.3 错误消息中文化

`normalizeErrorMessage(error)` 把底层英文消息翻译为中文，覆盖的关键字：

| 原始关键字（小写匹配）                       | 中文消息                                                            |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `ECONNREFUSED`                               | 连接被拒绝，请确认数据库服务已启动且端口可访问。                    |
| `ENOTFOUND`                                  | 无法解析主机名，请检查连接字符串中的域名是否正确。                  |
| `authentication failed` / `access denied`    | 认证失败，请检查用户名、密码（SQL 库还需确认该用户有目标库的访问权限）。 |
| `password authentication failed`             | 认证失败，请检查用户名和密码。                                      |
| `database ... does not exist`                | 目标数据库不存在，请检查连接字符串中的库名。                        |
| `timed out`                                  | 连接超时，请检查网络、白名单或数据库地址。                          |
| 其他                                         | 原始 `error.message`                                                |

### 11.4 业务层 `statusCode` 显式设置

下列 check 会直接抛 `error.statusCode = 400`：

- `requireActiveConnection`：未选择连接 → 400 "请先选择连接配置"
- `requireReadyContext`：未选数据库 → 400 "请先选择数据库"；未选集合 → 400 "请先选择集合"
- `/command` 命令为空 → 400 "命令不能为空"
- `/delete` 的 SQL 缺 WHERE → 400 "DELETE 必须提供 WHERE 条件"
- `/insert`、`/update` SET 内容为空对象 → 400 "插入内容不能为空" / "SET 内容不能为空"

---

## 12. 附录

### 12.1 典型调用流程

**新增 PG 连接并查询**：

```
1. POST   /login                                   → 取 cookie
2. POST   /connections        { type, uri, name }  → 创建记录
3. POST   /connections/:id/connect                 → 真实建连
4. GET    /databases                               → 拿库列表
5. POST   /database         { dbName }             → 选库
6. POST   /collection       { collectionName }     → 选表
7. POST   /query            { where, orderBy, limit } → 查询
8. POST   /connections/:id/disconnect              → 关闭连接池
```

### 12.2 持久化文件

`data/connections.json`：

```json
{
  "clients": {
    "<clientId>": {
      "activeConnectionId": "uuid",
      "connections": [ /* 见 §3.1 Connection */ ]
    }
  }
}
```

写入采用 `tmp` 文件 + `rename` 原子替换；通过 `persistQueue` 串行化避免并发写竞争。

### 12.3 运行时（内存）

```
runtimeStore: Map<clientId, Map<connectionId, { client | driver, lastPingAt }>>
```

- `client`：MongoDB `MongoClient` 实例
- `driver`：`PostgresDriver` / `MysqlDriver`（内部持 `pg.Pool` / `mysql2.Pool`）
- `lastPingAt`：10 秒内的 ping 走缓存，避免每次请求都 ping
- `reconnectLocks`：同一 `clientId:connectionId` 的并发重连会被去重为同一个 Promise

### 12.4 安全相关约束

- **必须** 设置 `MONGOX_PASSWORD`，否则启动失败
- 所有 API（除 `/login`、`/health`）必须带有效 `mongox_auth` cookie
- SQL 用户输入的 WHERE / ORDER BY 走白名单字符校验，禁止 `;` `--` `/* */`
- SQL 终端命令走单语句解析器 `assertSingleStatement`，识别字符串 / 行注释 / 块注释 / 美元引用 / 反引号
- mysql2 强制 `multipleStatements: false`
- 连接串密码在前端展示时一律走 `uriMasked`（password → `****`）

### 12.5 路由文件位置

| 路由组             | 代码位置（`src/server.js`） |
| ------------------ | --------------------------- |
| 鉴权（login/logout/health） | L1210–1237            |
| 状态查询（status/connections GET） | L1239–1254      |
| 连接管理（CRUD）   | L1256–1395                   |
| 旧版 connect/disconnect | L1397–1456              |
| 数据库 / 集合导航  | L1458–1647                   |
| CRUD（command/query/insert/update/delete） | L1649–1828 |
| 元数据（stats/indexes/collection-stats） | L1842–1972 |
| 导出               | L1974–2025                   |
| 错误中间件         | L2027–2036                   |
