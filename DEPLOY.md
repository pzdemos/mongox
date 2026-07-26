# 部署文档

本文档记录 mongox + SqlX 的部署相关配置。

## 环境信息

- 服务器: `root@121.43.33.235`
- Node.js: v21.7.3 (通过 nvm 管理)
- PM2: 进程管理器
- 项目路径: `/var/server/mongox`
- 应用端口: `5000`
- 前端源码: 与 mongox **同级** 的 `SqlX/`（可用 `SQLX_DIR` 覆盖）

## 部署模型

| 内容 | 如何上线 | Git |
|------|----------|-----|
| 后端 `src/` 等 | `git push` → 服务器 `git pull` | 跟踪 |
| 旧单页 `public/v1/` | 随 git 下发 | 跟踪（回滚用） |
| SqlX 构建产物 `public/index.html`、`public/assets/` | 本地打包后 **rsync/scp** | **忽略** |

流程概要：

1. 检查同级 `SqlX`（lockfile / node_modules / 关键依赖）
2. `pnpm run lint`（可 `SKIP_LINT=1` 跳过）+ `pnpm run build`
3. 同步到 `mongox/public/`（保留 `public/v1/`）
4. 提交并推送后端代码
5. 远程 `git pull` + `pm2 reload`
6. **再** rsync/scp 整个 `public/`（避免 pull 冲掉被 ignore 的构建产物）
7. 再次 reload + health check

## 一键部署脚本

### 交互式部署（推荐）

```bash
./scripts/deploy.sh "feat: xxx"
```

### 快速部署（非交互式）

```bash
./scripts/deploy-quick.sh
```

### 仅本地打包前端

```bash
./scripts/build-frontend.sh
# 或
SQLX_DIR=/path/to/SqlX SKIP_LINT=1 ./scripts/build-frontend.sh
```

## 手动部署流程

### 1. 本地构建前端

```bash
./scripts/build-frontend.sh
```

### 2. 代码更新

```bash
git add .
git commit -m "feat: xxx"
git push origin dev

ssh root@121.43.33.235 "git -C /var/server/mongox pull"
```

### 3. 上传 public

```bash
rsync -az --delete -e ssh public/ root@121.43.33.235:/var/server/mongox/public/
```

### 4. PM2 重载

```bash
ssh root@121.43.33.235 "/root/.nvm/versions/node/v21.7.3/bin/pm2 reload mongox"
```

### 5. 检查状态

```bash
ssh root@121.43.33.235 "/root/.nvm/versions/node/v21.7.3/bin/pm2 status mongox"
ssh root@121.43.33.235 "/root/.nvm/versions/node/v21.7.3/bin/pm2 logs mongox --lines 50"
```

## PM2 配置

项目已包含 `ecosystem.config.cjs`。部署前必须注入 `MONGOX_PASSWORD`：

```bash
export MONGOX_PASSWORD='<强密码>'
pm2 start ecosystem.config.cjs
# 或
pm2 restart mongox --update-env
```

## 端口与访问

| 应用 | 本地端口 | 外部访问 |
|------|----------|----------|
| mongox | 5000 | http://121.43.33.235:5000 |
| 新 UI (SqlX) | — | `/` 、`/login` |
| 旧单页 | — | `/v1/` 、`/v1/login.html` |

## 常见问题

### 502 / 无法访问

```bash
pm2 status mongox
pm2 logs mongox --lines 50
```

### 登录页空白 / JS 404

构建产物未上传：重新执行 `./scripts/build-frontend.sh` 并 rsync `public/`。

### 前端目录找不到

确认 `SqlXV2/SqlX` 与 `SqlXV2/mongox` 同级，或设置：

```bash
export SQLX_DIR=/absolute/path/to/SqlX
```

### 模块找不到（后端）

```bash
npm install
```
