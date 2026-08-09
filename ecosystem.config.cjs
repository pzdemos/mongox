// 部署前必须在服务器环境注入 MONGOX_PASSWORD：
//   export MONGOX_PASSWORD='<强密码>'
//   pm2 start ecosystem.config.cjs
//   # 或 pm2 restart mongox --update-env
// 未设置时 server.js 启动会直接 process.exit(1)
// AI 模式可选：DEEPSEEK_API_KEY / DEEPSEEK_API_BASE / DEEPSEEK_MODEL
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
      PORT: 5000,
      MONGOX_PASSWORD: process.env.MONGOX_PASSWORD || '',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
      DEEPSEEK_API_BASE: process.env.DEEPSEEK_API_BASE || '',
      DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || '',
    }
  }]
};
