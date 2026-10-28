// PM2 config for bare-metal deployment.
//
//   npm ci && npm run build
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup
//
// Environment comes from .env next to this file (Node reads it itself; already
// exported variables win). Postgres can be the compose service or a local one —
// DB_HOST / DB_PORT / PG_PORT in .env decide where the app looks.
module.exports = {
  apps: [
    {
      name: 'live-sync',
      script: 'server/index.js',
      cwd: __dirname,

      // FORK with a single instance on purpose. Each process keeps open rooms in
      // its own memory map and there is no cross-process pub/sub, so cluster
      // mode would put two people in the same notepad on different workers and
      // they would never see each other's edits. Scale vertically.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_memory_restart: '512M',

      node_args: '--env-file-if-exists=.env',

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
