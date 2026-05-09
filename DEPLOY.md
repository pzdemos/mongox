# 部署文档

本文档记录 mongox (MongoDB Admin Web) 项目的部署相关配置。

## 环境信息

- 服务器: `root@121.43.33.235`
- Node.js: v21.7.3 (通过 nvm 管理)
- PM2: 进程管理器
- 项目路径: `/var/server/mongox`
- 应用端口: `5000`

## 一键部署脚本

### 交互式部署（推荐）

```bash
./scripts/deploy.sh "feat: xxx"
```

功能：
- 检查本地变更
- 运行 `npm run check` 预提交检查
- 交互式提交代码
- 推送到远程仓库
- SSH 到服务器拉取代码并重启 PM2

### 快速部署（非交互式）

```bash
./scripts/deploy-quick.sh
```

功能：
- 自动检测变更并提交（自动生成 commit message）
- 推送到远程仓库
- SSH 到服务器拉取代码并重启 PM2

## 手动部署流程

### 1. 代码更新

```bash
# 本地提交并推送
git add .
git commit -m "feat: xxx"
git push origin dev

# 服务器拉取
ssh root@121.43.33.235 "git -C /var/server/mongox pull"
```

### 2. PM2 重载

```bash
ssh root@121.43.33.235 "/root/.nvm/versions/node/v21.7.3/bin/pm2 reload mongox"
```

### 3. 检查状态

```bash
# PM2 状态
ssh root@121.43.33.235 "/root/.nvm/versions/node/v21.7.3/bin/pm2 status mongox"

# 查看日志
ssh root@121.43.33.235 "/root/.nvm/versions/node/v21.7.3/bin/pm2 logs mongox --lines 50"
```

## PM2 配置

项目已包含 `ecosystem.config.cjs`：

```javascript
module.exports = {
  apps: [{
    name: 'mongox',
    script: 'src/server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    }
  }]
};
```

启动命令：
```bash
pm2 start ecosystem.config.cjs
```

## 端口映射

| 应用 | 本地端口 | 外部访问 |
|------|----------|----------|
| mongox | 5000 | http://121.43.33.235:5000 |

## 常见问题

### 502 / 无法访问

检查 PM2 应用状态和日志：
```bash
pm2 status mongox
pm2 logs mongox --lines 50
```

### MongoDB 连接失败

确认 MongoDB 服务已启动且端口可访问（默认 16016）。

### 模块找不到

```bash
npm install
```
