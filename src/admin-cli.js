#!/usr/bin/env node
// 账号维护 CLI：
//   node src/admin-cli.js create <email> <password> [quota]   创建/提升管理员（默认 ADMIN_QUOTA=10000）
//   node src/admin-cli.js list                                列出用户
//   node src/admin-cli.js set-quota <email> <n>               调整额度
//   node src/admin-cli.js usage [limit]                       最近 AI 用量
//   node src/admin-cli.js buckets                             列出连接桶（含匿名/用户桶）
//   node src/admin-cli.js adopt <clientId> <email>            把某桶连接迁移给某用户
import { createAdmin, listUsers, setQuota, listUsage } from "./accounts.js";
import { loadStore, persistStore, mergeClientConnections, persistentStore } from "./store.js";

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "create": {
      const [email, password, quota] = args;
      if (!email || !password) {
        console.error("用法: node src/admin-cli.js create <email> <password> [quota]");
        process.exit(1);
      }
      const result = createAdmin(email, password, quota ? Number(quota) : undefined);
      console.log(
        `${result.updated ? "已更新为管理员" : "管理员已创建"}: ${result.email} (quota=${result.quota})`
      );
      break;
    }
    case "list": {
      console.table(listUsers());
      break;
    }
    case "set-quota": {
      const [email, quota] = args;
      if (!email || quota === undefined) {
        console.error("用法: node src/admin-cli.js set-quota <email> <n>");
        process.exit(1);
      }
      console.log(setQuota(email, Number(quota)) ? "已更新" : "用户不存在");
      break;
    }
    case "usage": {
      console.table(listUsage(Number(args[0] || 20)));
      break;
    }
    case "buckets": {
      await loadStore();
      const rows = Object.entries(persistentStore.clients).map(([id, bucket]) => ({
        clientId: id.length > 18 ? `${id.slice(0, 14)}…` : id,
        connections: bucket.connections.length,
        detail: bucket.connections
          .map((c) => `${c.name || c.type}(${c.type})`)
          .join(" | ")
          .slice(0, 80),
        lastActiveAt: bucket.lastActiveAt,
      }));
      console.table(rows);
      break;
    }
    case "adopt": {
      const [fromId, email] = args;
      if (!fromId || !email) {
        console.error("用法: node src/admin-cli.js adopt <clientId> <email>");
        process.exit(1);
      }
      await loadStore();
      const user = listUsers().find((u) => u.email === String(email).toLowerCase());
      if (!user) {
        console.error(`用户不存在: ${email}`);
        process.exit(1);
      }
      const bucket = persistentStore.clients[fromId];
      if (!bucket?.connections?.length) {
        console.error("源桶不存在或没有连接");
        process.exit(1);
      }
      const { added, skipped } = mergeClientConnections(fromId, `user-${user.id}`);
      await persistStore();
      console.log(`已迁移 ${added} 个连接给 ${user.email}（去重跳过 ${skipped} 个）`);
      console.log("⚠️ 服务器运行中请执行 pm2 restart mongox 重读 connections.json，否则内存态会覆盖迁移结果");
      break;
    }
    default:
      console.error("用法: node src/admin-cli.js <create|list|set-quota|usage|buckets|adopt> ...");
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`错误: ${error.message}`);
  process.exit(1);
});
