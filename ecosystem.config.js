// PM2 process definition for the API.
//
// The web app carries its own config in its own repo. Both register into the
// single PM2 daemon on the instance, so anything here must name only
// `govmeeting-api` — a deploy that runs `pm2 reload all` would bounce the web
// app too.
module.exports = {
  apps: [
    {
      name: 'govmeeting-api',
      // Resolved against this file, so `pm2 start` works from any directory.
      cwd: __dirname,
      // nest build emits to dist/src/, not dist/ — the prisma/ files in the
      // compilation root push everything down a level. Matches the
      // `start:prod` script in package.json.
      script: 'dist/src/main.js',
      instances: 1,
      exec_mode: 'fork',
      // The port is deliberately absent: main.ts reads APP_PORT from .env via
      // ConfigModule, and a copy here would be free to drift from it.
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/api-error.log',
      out_file: 'logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: false,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      listen_timeout: 30000,
      kill_timeout: 5000,
    },
  ],
};
