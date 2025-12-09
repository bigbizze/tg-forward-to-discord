
const shared = {
  cwd: '/opt/tg-discord',
  instances: 1,
  time: true,
}

module.exports = {
  apps: [
    {
      name: 'express-server',
      script: './apps/express-server/dist/index.js',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=4096'
      },
      error_file: './logs/express-server-error.log',
      out_file: './logs/express-server-out.log'
    },
    {
      name: 'discord-bot',
      script: './apps/discord-bot/dist/index.js',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=4096'
      },
      error_file: './logs/discord-bot-error.log',
      out_file: './logs/discord-bot-out.log'
    },
    {
      name: 'python-scraper',
      script: './apps/python-scraper/.venv/bin/python',
      args: './apps/python-scraper/scrape.py',
      interpreter: 'none',
      exec_mode: 'fork',
      env: {
        PYTHONUNBUFFERED: '1',
      },
      error_file: './logs/python-scraper-error.log',
      out_file: './logs/python-scraper-out.log'
    },
    {
      name: 'log-dashboard',
      script: './apps/log-dashboard/dist/index.js',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        npm_config_production: 'true',
        NODE_OPTIONS: '--max-old-space-size=4096'
      },
      error_file: './logs/log-dashboard-error.log',
      out_file: './logs/log-dashboard-out.log'
    },
  ].map(x => ({ ...shared, ...x })),
};