#!/usr/bin/env node
// 账号维护 CLI：
//   node src/admin-cli.js create <email> <password> [quota]   创建/提升管理员（默认 ADMIN_QUOTA=10000）
//   node src/admin-cli.js list                                列出用户
//   node src/admin-cli.js set-quota <email> <n>               调整额度
//   node src/admin-cli.js usage [limit]                       最近 AI 用量
import { createAdmin, listUsers, setQuota, listUsage } from "./accounts.js";

const [cmd, ...args] = process.argv.slice(2);

try {
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
      const rows = listUsers();
      console.table(rows);
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
      const rows = listUsage(Number(args[0] || 20));
      console.table(rows);
      break;
    }
    default:
      console.error("用法: node src/admin-cli.js <create|list|set-quota|usage> ...");
      process.exit(1);
  }
} catch (error) {
  console.error(`错误: ${error.message}`);
  process.exit(1);
}
