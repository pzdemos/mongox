# MongoDB Admin Web

Node.js + Express 的 MongoDB Web 管理工具，支持本地/远程连接、CRUD、查询多视图和多格式导出。

## 功能

- 输入任意 MongoDB 连接字符串（本地或远程）
- 选择数据库与集合（可下拉选择，也可手动输入）
- 文档 CRUD：
  - 查询（Filter / Projection / Sort / Limit）
  - 新增（insertOne）
  - 更新（updateOne / updateMany / upsert）
  - 删除（deleteOne / deleteMany）
- 查询结果三种视图：
  - 表格视图
  - JSON 视图
  - 卡片视图
- 导出四种格式：
  - JSON
  - YAML
  - CSV
  - NDJSON

## 启动

```bash
npm install
npm start
```

启动后访问：

[http://localhost:5000](http://localhost:5000)

## 可选脚本

```bash
npm run check
npm run start:cli
```

`start:cli` 是同仓库里保留的 CLI 版本入口。
