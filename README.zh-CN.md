<div align="center">

# SqlX

**自部署的 Web 数据库客户端 —— 用一套界面管理 MongoDB、PostgreSQL 和 MySQL。**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

[English](README.md) · [简体中文](README.zh-CN.md)

<img src="docs/screenshots/table-crud.png" alt="SqlX 表格视图与交互式 CRUD" width="900">

</div>

## 为什么做 SqlX

桌面数据库客户端笨重、按席位收费，而且连不上内网里的数据。SqlX 是一个轻量的 Node.js 服务，放到任何服务器上，就能在浏览器里（含手机端）管理 MongoDB、PostgreSQL 和 MySQL。

- **开箱即用** —— `git clone`、`npm install`、`npm start` 三步启动，前端已预构建，无需编译。
- **三种引擎，一套界面** —— 保存多个不同类型的连接，随时切换。
- **电子表格级编辑** —— 双击单元格编辑、表内新增行、批量选择/复制/导出/删除。
- **真正的终端** —— Mongo 用 mongosh 风格命令，PG/MySQL 直接写 SQL，支持 Tab 补全与历史记录。
- **默认安全** —— 密码登录（HMAC 签名 Cookie）、连接串脱敏、请求限流。

## 功能

| | |
|---|---|
| 连接管理 | 保存 / 连接 / 断开 / 删除，三种数据库类型并存 |
| 结构浏览 | 数据库树、跨库搜索、右键菜单查看索引与统计 |
| 条件查询 | Filter / Projection / Sort / Limit，支持 JSON 与 EJSON |
| 命令模式 | Mongo 走 `db.users.find({...})`，PG/MySQL 走原生 SQL |
| 交互式表格 | 单元格行内编辑、整行编辑弹窗、列固定、批量操作 |
| 视图与导出 | 表格 / JSON / 卡片视图；导出 JSON、YAML、CSV、NDJSON |
| DDL 操作 | 界面上直接建集合 / 建表、建删索引 |
| 智能连接 | Mongo 认证失败时自动尝试 `directConnection` 与 `authSource` 变体 |

<div align="center">
<img src="docs/screenshots/terminal-mongo.png" alt="mongosh 风格终端" width="440">
<img src="docs/screenshots/terminal-sql.png" alt="PostgreSQL SQL 终端" width="440">
</div>

## 快速开始

需要 Node.js >= 18。

```bash
git clone https://github.com/pzdemos/mongox.git sqlx
cd sqlx
npm install
MONGOX_PASSWORD=change-me npm start
```

打开 `http://localhost:5000`，用刚设置的密码登录，添加第一个连接。

### 配置

| 环境变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `MONGOX_PASSWORD` | 是 | — | Web 界面登录密码 |
| `PORT` | 否 | `5000` | HTTP 端口 |

### 使用 PM2 运行

```bash
export MONGOX_PASSWORD='<强密码>'
pm2 start ecosystem.config.cjs
```

## 安全说明

- 除 `/health` 和 `/login` 外，所有 API 都需要登录会话；会话为 HMAC 签名 Cookie，有效期 7 天。
- 已保存的连接串存放在服务端（`data/`，已 gitignore），API 返回时始终脱敏。
- SqlX 是数据库客户端，请像对待数据库客户端一样对待它：暴露公网时务必套 HTTPS，并用 VPN / 防火墙 / 反代鉴权限制访问。

## 架构

- **服务端** —— Express + 原生驱动（`mongodb`、`pg`、`mysql2`），REST API 挂在 `/mongo/api` 下，文档见 [docs/API.md](docs/API.md)。
- **前端** —— React 19 + Tailwind，源码在 [pzdemos/SqlX](https://github.com/pzdemos/SqlX)，预构建产物随本仓库分发（`public/`）。
- **旧版 UI** —— 原零依赖单页应用保留在 `/v1/`。

## 路线图

- [x] 中英文界面（跟随浏览器语言 + 应用内切换）
- [ ] 官方 Docker 镜像
- [ ] 查询历史与已保存查询
- [ ] 多用户、角色与审计日志
- [ ] 更多引擎：SQLite、Redis

## 许可证

[MIT](LICENSE)
