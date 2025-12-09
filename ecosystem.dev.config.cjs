const appRootPath = require('app-root-path');

const shared = {
  script: 'pnpm',
  cwd: appRootPath.path,
  autorestart: false,
  watch: false,
  instances: 1,
  exec_mode: 'fork',
  time: true,
}

module.exports = {
  apps: [
    {
      name: 'discord-bot',
      args: '-F @tg-discord/discord-bot dev',
      error_file: 'logs/discord-bot-error.log',
      out_file: 'logs/discord-bot-out.log'
    },
    {
      name: 'express-server',
      args: '-F @tg-discord/express-server dev',
      error_file: 'logs/express-server-error.log',
      out_file: 'logs/express-server-out.log'
    },
    {
      name: 'python-scraper',
      args: '-F @tg-discord/python-scraper dev',
      watch: false, // Do not change
      error_file: 'logs/python-scraper-error.log',
      out_file: 'logs/python-scraper-out.log'
    },
    {
      name: 'log-dashboard',
      args: '-F @tg-discord/log-dashboard dev:logs',
      watch: false,
      error_file: 'logs/log-dashboard-error.log',
      out_file: 'logs/log-dashboard-out.log'
    }
  ].map(x => ({ ...shared, ...x })),
}
