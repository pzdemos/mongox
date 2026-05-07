# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指引。

## 项目概述

MongoDB Admin Web（"Mongo Atelier"）— 轻量级单页 MongoDB 管理工具，同时提供 Web UI 和 CLI 两种界面。基于原生 JavaScript（ES 模块）、Express 和 MongoDB Node.js 驱动构建。无构建步骤、无转译、无前端框架。

## 常用命令

```bash
npm install          # 安装依赖
npm start            # 启动 Web 服务器（默认端口 5000，可通过 PORT 环境变量配置）
npm run start:cli    # 启动交互式 CLI 版本
npm run check        # 使用 node --check 对 server.js 和 index.js 做语法检查
```

项目未配置测试框架和代码检查工具，`npm run check` 是唯一的验证手段。

## 架构

### 后端（`src/server.js`）

单文件 Express 服务器（约 1070 行），负责托管静态前端并在 `/mongo/api` 前缀下暴露 REST API。关键模式：

- **单例状态**：模块级 `state` 对象持有唯一的 MongoDB `client`、当前 `uri`、`dbName` 和 `collectionName`，所有路由共享读写此状态。
- **EJSON 全程使用**：使用 BSON 的 `EJSON` 进行 MongoDB 类型序列化。`toTransport()` 将值转为 EJSON 安全的普通 JSON 用于 API 响应。`parseEjsonInput()` 支持 EJSON 解析，并以 JSON5 作为宽松输入的降级方案。
- **自适应连接重试**：`connectWithAdaptiveRetry()` 先尝试原始 URI，认证失败时自动重试 `directConnection=true` 以及各种 `authSource`/`authMechanism` 组合。
- **MongoDB Shell 命令解析器**：`/command` 端点接受 `db.collection.method(...)` 语法。`parseTerminalCommand()` 和 `parseMethodChain()` 将其解析为结构化操作对象，支持链式调用如 `.find({}).sort({name:1}).limit(10)`。
- **自动 $set 包装**：`/update` 端点在未检测到更新操作符时，自动将普通对象包装为 `$set`。
- **错误处理**：`asyncHandler` 包装路由处理函数；全局错误中间件将 MongoDB 错误转换为用户友好的中文消息。
- **无数据库**：连接信息为会话级（仅内存），服务器重启后丢失。

### CLI（`src/index.js`）

基于 Inquirer 提示的交互式 CLI（约 700 行）。共享相同的 MongoDB 操作逻辑，但通过菜单驱动而非 HTTP。与 Web 服务器相互独立。

### 前端（`public/`）

- `index.html` — 单页应用，侧边栏布局（连接/数据库/集合选择器）+ 主内容区
- `app.js`（约 1600 行）— 原生 JS，DOM 操作，无框架、无状态管理库，通过 `fetch()` 与后端 API 通信
- `styles.css`（约 1700 行）— 完整 CSS，支持移动端响应式布局和背景装饰元素

UI 中有三种文档视图模式：表格、JSON、树形（卡片）。还包含终端/命令输入框，支持原始 `db.collection.find()` 风格查询。

### API 路由

所有路由前缀为 `/mongo/api`：
- `POST /connect`、`POST /disconnect` — MongoDB 连接管理
- `GET /status`、`GET /health` — 连接状态
- `GET /databases`、`POST /database` — 列出/选择数据库
- `GET /collections`、`POST /collection` — 列出/选择集合
- `POST /query` — 查询（支持 filter/projection/sort/limit）
- `POST /command` — 原始 `db.collection.method()` 终端命令
- `POST /insert`、`POST /update`、`POST /delete` — CRUD 操作
- `GET /stats` — 集合统计信息
- `POST /export` — 导出为 JSON/YAML/CSV/NDJSON（返回文件下载）

### PM2

`ecosystem.config.cjs` 用于 PM2 生产部署，默认端口 5000，内存限制 1GB。

## 关键约定

- **界面语言**：UI 文本和错误消息均为中文（zh-CN）
- **默认 MongoDB 端口**：16016（非标准 27017）— 体现在默认连接字符串中
- **ES 模块**：package.json 中 `"type": "module"`，全程使用 `import`/`export`
- **Node.js >= 18**
- **MongoDB 驱动 v4**：使用兼容回调的 v4 API（非 v5+）
- **BSON v4**：EJSON 从 `bson` 包导入，非 `mongodb`
